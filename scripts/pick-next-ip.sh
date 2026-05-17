#!/usr/bin/env bash
# Pick the next free customer IP in 10.10.31.10..200.
# Atomic via UNIQUE constraint on vms.ip.
#
# Usage: pick-next-ip.sh <slug>
# Output: stdout = the IP, e.g. 10.10.31.42

source "$(dirname "$0")/common.sh"
require_env OPS_DB_URL
require_cmd psql

slug="${1:?Usage: $0 <slug>}"
validate_slug "$slug"

used=$(ops_db -c "SELECT host(ip) FROM vms WHERE ip << inet '10.10.31.0/24' ORDER BY ip")

for last in $(seq 10 200); do
  candidate="10.10.31.${last}"
  if ! grep -qx "$candidate" <<<"$used"; then
    if ops_db -c "UPDATE vms SET ip='$candidate' WHERE customer_slug='$slug' AND ip IS NULL RETURNING ip" | grep -qx "$candidate"; then
      echo "$candidate"
      exit 0
    fi
  fi
done

die "No free IP in 10.10.31.10..200"
