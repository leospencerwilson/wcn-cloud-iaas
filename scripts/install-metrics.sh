#!/usr/bin/env bash
# Install node_exporter + cAdvisor on a customer VM and register
# scrape targets with the central Prometheus. Idempotent.
#
# Usage: install-metrics.sh --slug acme
#
# Called from provision-customer.sh as the last step. Safe to re-run.

source "$(dirname "$0")/common.sh"

require_env OPS_DB_URL
require_cmd ssh psql curl

SLUG=""
while (( $# > 0 )); do
  case "$1" in
    --slug) SLUG="$2"; shift 2;;
    *) die "Unknown arg: $1";;
  esac
done
[[ -z "$SLUG" ]] && die "Missing --slug"

read -r IP <<<"$(ops_db -c "SELECT host(ip) FROM vms WHERE customer_slug='${SLUG}'")"
[[ -n "$IP" ]] || die "No VM IP for slug '$SLUG'"

# Coolify VM IP — the provisioner runs here and is the Prometheus
# scrape source. Override via PROVISIONER_SCRAPE_IP env if needed.
SCRAPE_IP="${PROVISIONER_SCRAPE_IP:-10.10.30.10}"

info "[metrics] $SLUG @ $IP — installing exporters"

pssh ops@"$IP" sudo bash -s <<REMOTE
set -e

# 1. ufw rules for Prometheus scrape
ufw allow from ${SCRAPE_IP} to any port 9100 proto tcp >/dev/null
ufw allow from ${SCRAPE_IP} to any port 8083 proto tcp >/dev/null

# 2. node_exporter (host net, port 9100)
if ! docker ps --format '{{.Names}}' | grep -q '^node-exporter\$'; then
  docker rm -f node-exporter 2>/dev/null || true
  docker run -d --name node-exporter --restart=unless-stopped \\
    --net=host --pid=host \\
    -v /:/host:ro,rslave \\
    quay.io/prometheus/node-exporter:v1.8.2 \\
    --path.rootfs=/host
fi

# 3. cAdvisor (port 8083; 8080-8082 collide with coolify-proxy).
# v0.55+ required: earlier versions break on Docker 28's "overlayfs"
# storage driver and emit zero per-container metrics. Recreate the
# container if a wrong (older) image is currently used.
CADVISOR_IMAGE="gcr.io/cadvisor/cadvisor:v0.55.1"
CURRENT_IMG=\$(docker inspect cadvisor --format '{{.Config.Image}}' 2>/dev/null || true)
if [[ -z "\$CURRENT_IMG" || "\$CURRENT_IMG" != "\$CADVISOR_IMAGE" ]]; then
  docker rm -f cadvisor 2>/dev/null || true
  docker run -d --name cadvisor --restart=unless-stopped \\
    -p 8083:8080 \\
    --volume=/:/rootfs:ro \\
    --volume=/var/run:/var/run:ro \\
    --volume=/sys:/sys:ro \\
    --volume=/var/lib/docker/:/var/lib/docker:ro \\
    --volume=/dev/disk/:/dev/disk:ro \\
    --privileged --device=/dev/kmsg \\
    "\$CADVISOR_IMAGE"
fi
REMOTE

ok "[metrics] $SLUG — exporters running"

# 4. Write Prometheus target file (on this host)
TARGETS_DIR=/opt/wcn-cloud/prometheus/targets
mkdir -p "$TARGETS_DIR"
cat > "$TARGETS_DIR/${SLUG}.json" <<JSON
[
  {"targets":["${IP}:9100"],"labels":{"slug":"${SLUG}","kind":"node"}},
  {"targets":["${IP}:8083"],"labels":{"slug":"${SLUG}","kind":"cadvisor"}}
]
JSON

# 5. Reload Prometheus
curl -sS -X POST http://127.0.0.1:9090/-/reload || warn "Prometheus reload failed"

ok "[metrics] $SLUG — scrape target registered"
