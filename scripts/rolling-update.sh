#!/usr/bin/env bash
# Roll out a template / component update across the customer fleet.
# Snapshots each VM before updating; rolls back automatically on health-check fail.
#
# Usage:
#   rolling-update.sh --component coolify        # update Coolify on every active VM
#   rolling-update.sh --component caddy --batch-size 3
#   rolling-update.sh --component all --dry-run
#   rolling-update.sh --component coolify --skip-customers acme,foo

source "$(dirname "$0")/common.sh"
HERE="$(cd "$(dirname "$0")" && pwd)"

require_env PROXMOX_API_TOKEN PROXMOX_HOST OPS_DB_URL
require_cmd ssh psql

COMPONENT=""; BATCH=1; DRY=false; SKIP=""
while (( $# > 0 )); do
  case "$1" in
    --component) COMPONENT="$2"; shift 2;;
    --batch-size) BATCH="$2"; shift 2;;
    --dry-run) DRY=true; shift;;
    --skip-customers) SKIP="$2"; shift 2;;
    --help|-h) sed -n '2,11p' "$0"; exit 0;;
    *) die "Unknown arg: $1";;
  esac
done

case "$COMPONENT" in
  coolify|caddy|cloudflared|all) ;;
  *) die "--component must be one of: coolify, caddy, cloudflared, all";;
esac
(( BATCH >= 1 && BATCH <= 5 )) || die "--batch-size must be 1..5"

# Get the fleet, ordered: site-tier first (lowest blast radius), then by least-recently-touched.
mapfile -t fleet < <(ops_db -c "
  SELECT c.slug, v.vmid, v.ip, c.tier
  FROM customers c JOIN vms v ON v.customer_slug=c.slug
  WHERE c.status='active' AND v.status='active'
  ORDER BY CASE c.tier WHEN 'site' THEN 0 WHEN 'site-db' THEN 1 ELSE 2 END,
           v.last_updated_at NULLS FIRST
")

skip_list=$(echo "$SKIP" | tr ',' '\n')

info "Fleet: ${#fleet[@]} active VMs. Component: $COMPONENT. Batch size: $BATCH. Dry-run: $DRY."

# ── upgrade fn for each component ─────────────────────────────────────
upgrade_one() {
  local slug="$1" vmid="$2" ip="$3" tier="$4"
  local snap="rolling-update-${COMPONENT}-$(date +%Y%m%d-%H%M)"

  if grep -qx "$slug" <<<"$skip_list"; then
    info "  $slug: skipped (in --skip-customers)"
    return 0
  fi

  if $DRY; then
    info "  $slug ($ip): would upgrade $COMPONENT"
    return 0
  fi

  ops_db_audit "rolling-update-start" "$slug" "component=$COMPONENT"

  # Snapshot
  ssh root@"$PROXMOX_HOST" "qm snapshot $vmid $snap --description 'pre-rolling-update $COMPONENT'" \
    || { err "  $slug: snapshot failed, skipping"; return 1; }

  # Upgrade
  case "$COMPONENT" in
    coolify)
      ssh ops@"$ip" 'cd /data/coolify/source && sudo bash upgrade.sh' || { rollback "$slug" "$vmid" "$snap"; return 1; };;
    caddy)
      ssh ops@"$ip" 'sudo apt update && sudo apt install -y caddy && sudo systemctl restart caddy' || { rollback "$slug" "$vmid" "$snap"; return 1; };;
    cloudflared)
      ssh ops@"$ip" 'sudo apt update && sudo apt install -y cloudflared && sudo systemctl restart cloudflared' || { rollback "$slug" "$vmid" "$snap"; return 1; };;
    all)
      ssh ops@"$ip" 'sudo apt update && sudo apt full-upgrade -y' || { rollback "$slug" "$vmid" "$snap"; return 1; };;
  esac

  # Health-check
  if ! "$HERE/customer-health-check.sh" "$slug" >/dev/null; then
    err "  $slug: health check failed after upgrade"
    rollback "$slug" "$vmid" "$snap"
    return 1
  fi

  # Success — drop snapshot to free disk
  ssh root@"$PROXMOX_HOST" "qm delsnapshot $vmid $snap" || true
  ops_db -c "UPDATE vms SET last_updated_at=now() WHERE customer_slug='$slug'"
  ops_db_audit "rolling-update-done" "$slug" "component=$COMPONENT"
  ok "  $slug: upgraded"
}

rollback() {
  local slug="$1" vmid="$2" snap="$3"
  warn "  $slug: rolling back to snapshot $snap"
  ssh root@"$PROXMOX_HOST" "qm rollback $vmid $snap" \
    && ssh root@"$PROXMOX_HOST" "qm start $vmid" \
    && ssh root@"$PROXMOX_HOST" "qm delsnapshot $vmid $snap"
  ops_db_audit "rolling-update-rollback" "$slug" "component=$COMPONENT"
}

# ── batch driver ──────────────────────────────────────────────────────
fails=()
i=0
while (( i < ${#fleet[@]} )); do
  end=$((i + BATCH))
  (( end > ${#fleet[@]} )) && end=${#fleet[@]}

  info "── Batch $((i / BATCH + 1)): VMs ${i}..$((end-1)) ──"

  pids=()
  for (( j = i; j < end; j++ )); do
    IFS='|' read -r slug vmid ip tier <<<"${fleet[j]}"
    upgrade_one "$slug" "$vmid" "$ip" "$tier" &
    pids+=($!)
  done

  for pid in "${pids[@]}"; do
    wait "$pid" || fails+=("pid=$pid")
  done

  i=$end
done

if (( ${#fails[@]} > 0 )); then
  err "Rolling update finished with ${#fails[@]} failure(s). Check logs."
  exit 1
fi

ok "Rolling update of '$COMPONENT' complete on ${#fleet[@]} VMs"
