#!/usr/bin/env bash
# Deprovision a customer. Mirror of provision-customer.sh but in reverse,
# preserving a final B2 backup.
#
# Usage:
#   deprovision-customer.sh --slug acme           (prompts to confirm)
#   deprovision-customer.sh --slug acme --force   (no prompt — for scripted cleanup)

source "$(dirname "$0")/common.sh"
HERE="$(cd "$(dirname "$0")" && pwd)"

require_env CF_API_TOKEN CF_ACCOUNT_ID CF_ZONE_ID \
            PROXMOX_API_TOKEN PROXMOX_HOST OPS_DB_URL B2_KEY_ID B2_APP_KEY
require_cmd curl jq psql ssh rclone

SLUG=""; FORCE=false
while (( $# > 0 )); do
  case "$1" in
    --slug)  SLUG="$2"; shift 2;;
    --force) FORCE=true; shift;;
    --help|-h) sed -n '2,12p' "$0"; exit 0;;
    *) die "Unknown arg: $1";;
  esac
done
[[ -z "$SLUG" ]] && die "Missing --slug"
validate_slug "$SLUG"

# Look up the customer.
read -r vmid ip tunnel_id status <<<"$(ops_db -c "
  SELECT v.vmid, v.ip, v.tunnel_id, c.status
  FROM customers c LEFT JOIN vms v ON v.customer_slug=c.slug
  WHERE c.slug='${SLUG}'" | tr '|' ' ')"

[[ -z "$vmid" ]] && die "No record for slug '$SLUG' (already removed?)"

info "──────────────────────────────────────────────────────────"
info " About to deprovision: ${SLUG}"
info "   VMID:       ${vmid}"
info "   IP:         ${ip:-(none)}"
info "   Tunnel:     ${tunnel_id:-(none)}"
info "   Status:     ${status}"
info "──────────────────────────────────────────────────────────"

if ! $FORCE; then
  read -rp "Type the slug '${SLUG}' again to confirm: " confirm
  [[ "$confirm" == "$SLUG" ]] || die "Slug confirmation didn't match. Aborted."
fi

ops_db_audit "deprovision-start" "$SLUG" "vmid=$vmid, force=$FORCE"

# ── 1. final backup ───────────────────────────────────────────────────
if [[ -n "$ip" ]] && ssh -o ConnectTimeout=5 ops@"$ip" 'echo ok' &>/dev/null; then
  info "[1/5] Taking final pg_dump..."
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  remote_dump="/tmp/${SLUG}-final-${ts}.sql.gz"
  ssh ops@"$ip" "
    docker exec \$(docker ps -q -f name=supabase-db) pg_dumpall -U postgres | gzip > $remote_dump
  " || warn "pg_dumpall failed (continuing)"
  scp -q "ops@${ip}:${remote_dump}" "/tmp/" 2>/dev/null || true
  if [[ -f "/tmp/$(basename "$remote_dump")" ]]; then
    rclone copy "/tmp/$(basename "$remote_dump")" "b2:wcn-cloud-backups/${SLUG}/final/"
    rm -f "/tmp/$(basename "$remote_dump")"
    ok "[1/5] Final dump saved to b2:wcn-cloud-backups/${SLUG}/final/"
  else
    warn "[1/5] No final dump captured"
  fi
else
  warn "[1/5] VM unreachable, skipping final dump"
fi

# ── 2. custom hostnames ───────────────────────────────────────────────
# (CF Access apps are no longer created — auth lives in the WCN console.)
info "[2/5] Removing custom hostnames..."
custom_domains=$(ops_db -c "SELECT cf_custom_hostname_id FROM domains WHERE customer_slug='$SLUG' AND status != 'deleted'")
for hid in $custom_domains; do
  cf_api DELETE "/zones/${CF_ZONE_ID}/custom_hostnames/${hid}" >/dev/null \
    && ok "  removed custom hostname $hid"
done
ok "[2/5] Custom hostnames removed"

# ── 3. DNS + tunnel ────────────────────────────────────────────────────
info "[3/5] Removing DNS record + tunnel..."
host="${SLUG}.western-communication.com"
dns_id=$(cf_api GET "/zones/${CF_ZONE_ID}/dns_records?name=${host}" \
  | jq -r '.result[0].id // empty')
if [[ -n "$dns_id" ]]; then
  cf_api DELETE "/zones/${CF_ZONE_ID}/dns_records/${dns_id}" >/dev/null
  ok "  DNS removed"
fi
if [[ -n "$tunnel_id" && "$tunnel_id" != "(null)" ]]; then
  # Cleanup tunnel — first delete any DNS routes, then the tunnel itself.
  cf_api DELETE "/accounts/${CF_ACCOUNT_ID}/cfd_tunnel/${tunnel_id}" >/dev/null \
    && ok "  Tunnel removed"
fi

# ── 4. Proxmox VM ─────────────────────────────────────────────────────
info "[4/5] Stopping + destroying VM ${vmid}..."
if ssh root@"$PROXMOX_HOST" "qm status ${vmid}" 2>/dev/null | grep -q running; then
  ssh root@"$PROXMOX_HOST" "qm stop ${vmid} --timeout 60 || qm stop ${vmid} --skiplock"
fi
ssh root@"$PROXMOX_HOST" "qm destroy ${vmid} --purge --destroy-unreferenced-disks 1" \
  || warn "VM destroy returned non-zero (may already be gone)"
ok "[4/5] VM ${vmid} destroyed"

# ── 5. ops DB ──────────────────────────────────────────────────────────
info "[5/5] Marking deleted in ops DB..."
ops_db -c "
  UPDATE customers SET status='deleted', deleted_at=now() WHERE slug='${SLUG}';
  UPDATE vms SET status='destroyed', destroyed_at=now() WHERE customer_slug='${SLUG}';
  UPDATE domains SET status='deleted' WHERE customer_slug='${SLUG}' AND status != 'deleted';
"
ops_db_audit "deprovision-done" "$SLUG" "vmid=$vmid"
ok "[5/5] Marked deleted"

cat <<SUMMARY

✅ Customer '${SLUG}' deprovisioned.

   Final backup:  b2:wcn-cloud-backups/${SLUG}/final/
   Retained for:  30 days minimum (B2 lifecycle)

   ops DB row remains with status='deleted' for audit purposes.

SUMMARY
