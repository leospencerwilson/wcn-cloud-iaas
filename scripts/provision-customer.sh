#!/usr/bin/env bash
# Provision a new customer end-to-end.
#
# Usage:
#   provision-customer.sh \
#     --slug acme \
#     --tier pro \
#     --domain acme.com \
#     --email admin@acme.com \
#     --name "Acme Ltd" \
#     [--brand-colour "#ff5500"] \
#     [--resume]                       (skip already-completed steps)
#
# Idempotent: re-running with the same slug picks up where it left off.

source "$(dirname "$0")/common.sh"
HERE="$(cd "$(dirname "$0")" && pwd)"

require_env CF_API_TOKEN CF_ACCOUNT_ID CF_ZONE_ID \
            PROXMOX_API_TOKEN PROXMOX_HOST OPS_DB_URL
require_cmd curl jq psql ssh scp

# ── parse args ─────────────────────────────────────────────────────────
SLUG=""; TIER=""; DOMAIN=""; EMAIL=""; NAME=""; BRAND_COLOUR="#3b82f6"; RESUME=false
while (( $# > 0 )); do
  case "$1" in
    --slug)         SLUG="$2"; shift 2;;
    --tier)         TIER="$2"; shift 2;;
    --domain)       DOMAIN="$2"; shift 2;;
    --email)        EMAIL="$2"; shift 2;;
    --name)         NAME="$2"; shift 2;;
    --brand-colour) BRAND_COLOUR="$2"; shift 2;;
    --resume)       RESUME=true; shift;;
    --help|-h)      sed -n '2,15p' "$0"; exit 0;;
    *) die "Unknown arg: $1";;
  esac
done

for v in SLUG TIER EMAIL NAME; do
  [[ -z "${!v}" ]] && die "Missing --${v,,} (run with --help)"
done

validate_slug "$SLUG"
validate_tier "$TIER"
validate_email "$EMAIL"

info "──────────────────────────────────────────────────────────"
info " Provisioning customer: ${NAME} (${SLUG}, tier=${TIER})"
info "──────────────────────────────────────────────────────────"

# ── 1. validate not already taken (unless --resume) ────────────────────
existing=$(ops_db -c "SELECT status FROM customers WHERE slug='${SLUG}'")
if [[ -n "$existing" ]]; then
  if ! $RESUME; then
    die "Slug '$SLUG' exists with status='$existing'. Use --resume to continue, or pick another slug."
  fi
  info "[1/9] Resuming existing customer ($existing)... ok"
else
  info "[1/9] Creating customer record..."
  ops_db -c "INSERT INTO customers (slug, name, tier, contact_email, brand_primary, status) VALUES (
    '${SLUG}', \$\$${NAME}\$\$, '${TIER}', '${EMAIL}', '${BRAND_COLOUR}', 'provisioning')"
  ops_db_audit "provision-start" "$SLUG" "tier=$TIER, email=$EMAIL"
  ok "[1/9] Customer record created"
fi

# ── 2. allocate VMID + IP ──────────────────────────────────────────────
existing_vmid=$(ops_db -c "SELECT vmid FROM vms WHERE customer_slug='$SLUG'")
if [[ -n "$existing_vmid" ]]; then
  VMID="$existing_vmid"
  info "[2/9] Reusing VMID $VMID"
else
  info "[2/9] Allocating VMID..."
  VMID=$("$HERE/pick-next-vmid.sh" "$SLUG")
  ok "[2/9] VMID $VMID allocated"
fi

existing_ip=$(ops_db -c "SELECT ip FROM vms WHERE customer_slug='$SLUG' AND ip IS NOT NULL")
if [[ -n "$existing_ip" ]]; then
  IP="$existing_ip"
  info "       Reusing IP $IP"
else
  IP=$("$HERE/pick-next-ip.sh" "$SLUG")
  ok "       IP $IP allocated"
fi

# ── 3. CF tunnel ───────────────────────────────────────────────────────
existing_tunnel=$(ops_db -c "SELECT tunnel_id FROM vms WHERE customer_slug='$SLUG' AND tunnel_id IS NOT NULL")
CRED_PATH="/tmp/wcn-cloud-${SLUG}-cred.json"
if [[ -n "$existing_tunnel" ]]; then
  TUNNEL_ID="$existing_tunnel"
  info "[3/9] Reusing tunnel $TUNNEL_ID"
else
  info "[3/9] Creating Cloudflare Tunnel..."
  TUNNEL_ID=$("$HERE/create-cf-tunnel.sh" "$SLUG" "$CRED_PATH")
  ops_db -c "UPDATE vms SET tunnel_id='$TUNNEL_ID' WHERE customer_slug='$SLUG'"
  ok "[3/9] Tunnel $TUNNEL_ID created"
fi

# ── 4. DNS record ──────────────────────────────────────────────────────
console_host="${SLUG}.western-communication.com"
existing_dns=$(cf_api GET "/zones/${CF_ZONE_ID}/dns_records?name=${console_host}" \
  | jq -r '.result[0].id // empty')
if [[ -n "$existing_dns" ]]; then
  info "[4/9] DNS record exists ($existing_dns)"
else
  info "[4/9] Creating DNS record ${console_host}..."
  body=$(jq -nc \
    --arg name "$console_host" \
    --arg content "${TUNNEL_ID}.cfargotunnel.com" \
    '{type: "CNAME", name: $name, content: $content, proxied: true, ttl: 1}')
  response=$(cf_api POST "/zones/${CF_ZONE_ID}/dns_records" "$body")
  cf_api_ok "$response" || die "DNS create failed: $response"
  ok "[4/9] DNS record created"
fi

# ── 5. clone Proxmox VM ───────────────────────────────────────────────
if pve_api GET "/nodes/dreadnaught/qemu/${VMID}/status/current" \
   | jq -e '.data.status' >/dev/null 2>&1; then
  info "[5/9] VM ${VMID} already exists"
else
  info "[5/9] Cloning template 9001 → VMID ${VMID} (this takes ~3 min)..."
  ssh root@"$PROXMOX_HOST" "qm clone 9001 ${VMID} --name wcn-cloud-${SLUG} --full" \
    || die "Clone failed"
  ok "[5/9] Cloned"
fi

# ── 6. configure VM ───────────────────────────────────────────────────
info "[6/9] Configuring VM (cloud-init)..."
ssh root@"$PROXMOX_HOST" bash -s <<EOF
qm set ${VMID} \
  --ipconfig0 ip=${IP}/24,gw=10.10.31.1 \
  --nameserver "1.1.1.1 1.0.0.1" \
  --ciuser ops \
  --sshkeys ~/.ssh/authorized_keys \
  --tags "wcn-cloud,customer,${TIER}"
EOF
ok "[6/9] Configured"

# ── 7. start VM ────────────────────────────────────────────────────────
status=$(pve_api GET "/nodes/dreadnaught/qemu/${VMID}/status/current" | jq -r '.data.status')
if [[ "$status" == "running" ]]; then
  info "[7/9] VM already running"
else
  info "[7/9] Starting VM..."
  ssh root@"$PROXMOX_HOST" "qm start ${VMID}"
fi
"$HERE/wait-for-vm-ready.sh" "$VMID" "$IP"
ok "[7/9] VM ready"

# ── 8. push customer.env + run firstboot ──────────────────────────────
info "[8/9] Pushing customer.env + tunnel cred, running firstboot..."
"$HERE/render-customer-env.sh" \
  --slug "$SLUG" --tier "$TIER" --name "$NAME" \
  --email "$EMAIL" --domain "$DOMAIN" \
  --tunnel-id "$TUNNEL_ID" --brand-colour "$BRAND_COLOUR" \
  --ip "$IP" \
  > "/tmp/customer-${SLUG}.env"

scp -q "/tmp/customer-${SLUG}.env" "ops@${IP}:/tmp/customer.env"
[[ -f "$CRED_PATH" ]] && scp -q "$CRED_PATH" "ops@${IP}:/tmp/cf-cred.json"

ssh ops@"$IP" 'sudo install -m 600 -o root -g root /tmp/customer.env /etc/wcn-cloud/customer.env && \
                  if [[ -f /tmp/cf-cred.json ]]; then \
                    sudo install -m 600 -o root -g root /tmp/cf-cred.json /etc/wcn-cloud/cf-cred.json; \
                  fi && \
                  sudo systemctl start wcn-firstboot.service && \
                  sudo systemctl status wcn-firstboot.service --no-pager'
ok "[8/9] Firstboot complete"

# ── 9. health check + finalise ────────────────────────────────────────
# Auth is enforced by the WCN console (Caddy forward_auth → /api/verify),
# not Cloudflare Access. No per-customer CF Access apps to create.
info "[9/9] Health check..."
sleep 10
"$HERE/customer-health-check.sh" "$SLUG" || die "Health check failed — investigate"

ops_db -c "UPDATE customers SET status='active' WHERE slug='$SLUG'"
ops_db_audit "provision-done" "$SLUG" "vmid=$VMID, ip=$IP, tunnel=$TUNNEL_ID"

# Cleanup local cred file
rm -f "$CRED_PATH" "/tmp/customer-${SLUG}.env"

ok "[9/9] All checks passed"

cat <<SUMMARY

✅ Customer '${SLUG}' provisioned successfully.

   Console:   https://${console_host}/coolify
   Supabase:  https://${console_host}/supabase
   Admin:     ${EMAIL}  (signs in via the WCN console)

Next steps:
  • Send the welcome email (template: runbooks/new-customer.md)
  • When customer's ready, run:
      ./scripts/add-custom-domain.sh --slug ${SLUG} --domain ${DOMAIN}

SUMMARY
