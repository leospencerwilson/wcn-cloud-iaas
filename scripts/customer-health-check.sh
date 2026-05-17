#!/usr/bin/env bash
# Run a series of health checks on a freshly provisioned customer.
# Exit 0 if all pass, non-zero (with explanation) on first failure.
#
# Usage: customer-health-check.sh <slug>

source "$(dirname "$0")/common.sh"
require_env OPS_DB_URL
require_cmd curl jq psql ssh

slug="${1:?Usage: $0 <slug>}"
validate_slug "$slug"

IFS='|' read -r ip tier <<<"$(ops_db -c "SELECT host(v.ip), c.tier FROM vms v JOIN customers c ON c.slug=v.customer_slug WHERE v.customer_slug='$slug'")"
[[ -n "$ip" ]] || die "No VM record for slug '$slug'"

info "Health-checking $slug at $ip (tier=$tier)"

# 1. SSH in
if ! ssh -o ConnectTimeout=5 ops@"$ip" 'echo ok' >/dev/null; then
  die "SSH to $ip failed"
fi
ok "SSH"

# 2. Docker is running
if ! ssh ops@"$ip" 'docker ps' >/dev/null; then
  die "docker ps failed on $ip"
fi
ok "Docker"

# 3. Coolify health
if ! ssh ops@"$ip" 'curl -fs http://localhost:8000/api/health' >/dev/null; then
  die "Coolify health endpoint not responding on $ip"
fi
ok "Coolify"

# 4. Caddy is reverse-proxying
if ! ssh ops@"$ip" 'curl -fs http://localhost/healthz' >/dev/null; then
  die "Caddy /healthz not OK on $ip"
fi
ok "Caddy"

# 5. cloudflared is connected
status=$(ssh ops@"$ip" 'systemctl is-active cloudflared')
[[ "$status" == "active" ]] || die "cloudflared is $status on $ip"
ok "cloudflared service active"

# 6. Tunnel is healthy externally (CF reports active connections)
tunnel_id=$(ops_db -c "SELECT tunnel_id FROM vms WHERE customer_slug='$slug'")
conns=$(cf_api GET "/accounts/${CF_ACCOUNT_ID}/cfd_tunnel/${tunnel_id}" \
  | jq -r '.result.connections | length')
(( conns > 0 )) || die "Tunnel ${tunnel_id} has 0 active connections"
ok "Tunnel has ${conns} connection(s)"

# 7. (Tier-dependent) Supabase Studio responding
if [[ "$tier" != "site" ]]; then
  if ! ssh ops@"$ip" 'curl -fs http://localhost:3000/api/health' >/dev/null; then
    die "Supabase Studio not responding on $ip"
  fi
  ok "Supabase"
fi

ok "All health checks passed for $slug"
