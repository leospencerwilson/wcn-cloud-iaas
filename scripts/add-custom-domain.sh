#!/usr/bin/env bash
# Register a custom domain for a customer via Cloudflare for SaaS,
# then update the customer VM's Caddy + tunnel ingress to accept it.
#
# Usage:
#   add-custom-domain.sh --slug acme --domain shop.acme.com
#
# What it does:
#   1. POST /custom_hostnames to register shop.acme.com against our zone
#   2. Wait for the customer to add the CNAME (we print instructions)
#   3. Poll until validation succeeds
#   4. Update the customer VM's Caddyfile + cloudflared ingress to serve the new host
#   5. Record in ops DB

source "$(dirname "$0")/common.sh"
HERE="$(cd "$(dirname "$0")" && pwd)"

require_env CF_API_TOKEN CF_ACCOUNT_ID CF_ZONE_ID OPS_DB_URL
require_cmd curl jq psql ssh

SLUG=""; DOMAIN=""; TIMEOUT=600
while (( $# > 0 )); do
  case "$1" in
    --slug)    SLUG="$2"; shift 2;;
    --domain)  DOMAIN="$2"; shift 2;;
    --timeout) TIMEOUT="$2"; shift 2;;
    --help|-h) sed -n '2,12p' "$0"; exit 0;;
    *) die "Unknown arg: $1";;
  esac
done
[[ -z "$SLUG" ]] && die "Missing --slug"
[[ -z "$DOMAIN" ]] && die "Missing --domain"
validate_slug "$SLUG"

# Look up the customer's IP + tunnel.
read -r ip tunnel_id <<<"$(ops_db -c "SELECT ip, tunnel_id FROM vms WHERE customer_slug='$SLUG'" | tr '|' ' ')"
[[ -n "$ip" ]] || die "No active VM for slug '$SLUG'"

info "Adding custom domain '${DOMAIN}' to customer '${SLUG}' (VM ${ip})"

# ── 1. register the custom hostname ───────────────────────────────────
existing_hid=$(cf_api GET "/zones/${CF_ZONE_ID}/custom_hostnames?hostname=${DOMAIN}" \
  | jq -r '.result[0].id // empty')

if [[ -n "$existing_hid" ]]; then
  HID="$existing_hid"
  info "[1/5] Custom hostname exists (${HID})"
else
  body=$(jq -nc --arg hostname "$DOMAIN" \
    '{hostname: $hostname, ssl: {method: "txt", type: "dv", settings: {min_tls_version: "1.2"}}}')
  response=$(cf_api POST "/zones/${CF_ZONE_ID}/custom_hostnames" "$body")
  cf_api_ok "$response" || die "Custom hostname create failed: $response"
  HID=$(jq -r '.result.id' <<<"$response")
  ok "[1/5] Hostname registered: $HID"
fi

ops_db -c "
  INSERT INTO domains (customer_slug, hostname, cf_custom_hostname_id, status)
  VALUES ('${SLUG}', '${DOMAIN}', '${HID}', 'pending')
  ON CONFLICT (hostname) DO UPDATE SET cf_custom_hostname_id='${HID}', status='pending'"

# ── 2. show customer instructions ─────────────────────────────────────
cat <<MSG

────────────────────────────────────────────────────────────────────
 CUSTOMER ACTION REQUIRED
────────────────────────────────────────────────────────────────────
 Send the customer this message:

   Please add the following CNAME record to your DNS for ${DOMAIN}:

     Name:    ${DOMAIN}
     Type:    CNAME
     Target:  ${SLUG}.app.western-communication.com
     TTL:     auto / 300

   Once added, our system will detect it within ~5 minutes and
   issue an SSL certificate automatically. No further action needed.

 Press ENTER once you've informed the customer (the script will
 then poll Cloudflare until they've completed the DNS change)...
────────────────────────────────────────────────────────────────────
MSG
read -r

# ── 3. poll for validation ────────────────────────────────────────────
info "[2/5] Polling for hostname validation (timeout: ${TIMEOUT}s)..."
deadline=$(( $(date +%s) + TIMEOUT ))
while (( $(date +%s) < deadline )); do
  status=$(cf_api GET "/zones/${CF_ZONE_ID}/custom_hostnames/${HID}" \
    | jq -r '.result.status')
  ssl_status=$(cf_api GET "/zones/${CF_ZONE_ID}/custom_hostnames/${HID}" \
    | jq -r '.result.ssl.status')
  if [[ "$status" == "active" && "$ssl_status" == "active" ]]; then
    ok "[2/5] Hostname active, SSL active"
    break
  fi
  log "  status=$status, ssl=$ssl_status — checking again in 30s"
  sleep 30
done

if (( $(date +%s) >= deadline )); then
  die "Validation timed out. Customer DNS may not be propagated yet. Re-run with --slug $SLUG --domain $DOMAIN once they've added it."
fi

# ── 4. update tunnel ingress ──────────────────────────────────────────
info "[3/5] Updating Cloudflare Tunnel ingress..."
existing=$(cf_api GET "/accounts/${CF_ACCOUNT_ID}/cfd_tunnel/${tunnel_id}/configurations" \
  | jq '.result.config.ingress')

# Insert new hostname entry just before the catchall.
new_ingress=$(jq --arg h "$DOMAIN" \
  '. as $x
   | (length - 1) as $last
   | $x[:$last] + [{hostname: $h, service: "http://localhost:80"}] + $x[$last:]' \
  <<<"$existing")

config_body=$(jq -nc --argjson ingress "$new_ingress" '{config: {ingress: $ingress}}')
response=$(cf_api PUT "/accounts/${CF_ACCOUNT_ID}/cfd_tunnel/${tunnel_id}/configurations" "$config_body")
cf_api_ok "$response" || die "Tunnel ingress update failed: $response"
ok "[3/5] Tunnel ingress updated"

# ── 5. update Caddy on the VM ─────────────────────────────────────────
info "[4/5] Updating Caddyfile on VM..."
existing_domains=$(ops_db -c "SELECT hostname FROM domains WHERE customer_slug='$SLUG' AND status IN ('active','pending') ORDER BY hostname")

ssh ops@"$ip" bash -s <<EOF
set -e
sudo bash -c '
  source /etc/wcn-cloud/customer.env
  /opt/wcn-cloud/bin/render-caddyfile.sh /etc/wcn-cloud/customer.env $existing_domains > /etc/caddy/Caddyfile.new
  caddy validate --config /etc/caddy/Caddyfile.new --adapter caddyfile
  mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile
  systemctl reload caddy
'
EOF
ok "[4/5] Caddy reloaded"

# ── 6. mark active ────────────────────────────────────────────────────
ops_db -c "UPDATE domains SET status='active', activated_at=now() WHERE cf_custom_hostname_id='${HID}'"
ops_db_audit "domain-add" "$SLUG" "domain=$DOMAIN, hid=$HID"
ok "[5/5] Done"

cat <<SUMMARY

✅ Custom domain '${DOMAIN}' is live for customer '${SLUG}'.

   The customer can now point their visitors at https://${DOMAIN}.

SUMMARY
