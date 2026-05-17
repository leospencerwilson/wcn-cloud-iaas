#!/usr/bin/env bash
# Poll the Proxmox guest agent until the VM is reachable AND we can ssh in.
#
# Usage: wait-for-vm-ready.sh <vmid> <ip>

source "$(dirname "$0")/common.sh"
require_env PROXMOX_API_TOKEN PROXMOX_HOST
require_cmd curl jq ssh

vmid="${1:?Usage: $0 <vmid> <ip>}"
ip="${2:?Usage: $0 <vmid> <ip>}"
timeout="${TIMEOUT:-300}"  # 5 min default

deadline=$(( $(date +%s) + timeout ))

info "Waiting for VM ${vmid} at ${ip} (timeout: ${timeout}s)"

# Phase 1: Proxmox QEMU guest agent reports ready.
while (( $(date +%s) < deadline )); do
  response=$(pve_api POST "/nodes/dreadnaught/qemu/${vmid}/agent/ping" || true)
  if jq -e '.data' >/dev/null 2>&1 <<<"$response"; then
    ok "Guest agent responding"
    break
  fi
  sleep 5
done

if (( $(date +%s) >= deadline )); then
  die "Timed out waiting for guest agent on VM ${vmid}"
fi

# Phase 2: SSH reachable, returns expected output.
attempt=0
while (( $(date +%s) < deadline )); do
  attempt=$((attempt + 1))
  if out=$(ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new \
       ops@"${ip}" 'cloud-init status --wait' 2>&1); then
    ok "Cloud-init complete on ${ip}"
    return 0 2>/dev/null || exit 0
  fi
  # Surface the last error every 6 attempts (~30s) so we can diagnose.
  if (( attempt % 6 == 1 )); then
    warn "SSH attempt ${attempt} failed: ${out}"
  fi
  sleep 5
done

die "Timed out waiting for SSH/cloud-init on ${ip}"
