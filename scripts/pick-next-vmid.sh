#!/usr/bin/env bash
# Pick the next free customer VMID in 200-399.
# Reservation is atomic via the ops DB unique constraint.
#
# Usage: pick-next-vmid.sh <slug>
# Output: stdout = the VMID. Logs to stderr.

source "$(dirname "$0")/common.sh"

require_env PROXMOX_API_TOKEN PROXMOX_HOST OPS_DB_URL
require_cmd curl jq psql

slug="${1:?Usage: $0 <slug>}"
validate_slug "$slug"

# 1. List VMIDs already known to Proxmox in the customer range.
existing_pve=$(pve_api GET "/cluster/resources?type=vm" \
  | jq -r '.data[] | select(.vmid >= 200 and .vmid <= 399) | .vmid' \
  | sort -n)

# 2. List VMIDs reserved in our ops DB (may include not-yet-created VMs).
existing_db=$(ops_db -c "SELECT vmid FROM vms WHERE vmid BETWEEN 200 AND 399 ORDER BY vmid")

# 3. First gap.
all=$(printf '%s\n%s\n' "$existing_pve" "$existing_db" | sort -un)

for candidate in $(seq 200 399); do
  if ! grep -qx "$candidate" <<<"$all"; then
    # 4. Try to claim it. The unique constraint on (vmid) prevents races.
    if ops_db -c "INSERT INTO vms (vmid, customer_slug, status) VALUES ($candidate, '$slug', 'reserving') ON CONFLICT (vmid) DO NOTHING RETURNING vmid" | grep -qx "$candidate"; then
      echo "$candidate"
      exit 0
    fi
  fi
done

die "No free VMID in 200-399"
