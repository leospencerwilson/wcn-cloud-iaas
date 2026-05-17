#!/usr/bin/env bash
# Create a Cloudflare Tunnel for a customer.
#
# Usage: create-cf-tunnel.sh <slug> <output-cred-path>
#   <slug>            the customer slug
#   <output-cred-path>  where to write the tunnel credentials JSON (will scp to VM later)
#
# Env required: CF_API_TOKEN, CF_ACCOUNT_ID
# Stdout: tunnel UUID

source "$(dirname "$0")/common.sh"
require_env CF_API_TOKEN CF_ACCOUNT_ID
require_cmd curl jq

slug="${1:?Usage: $0 <slug> <cred-path>}"
cred_path="${2:?Usage: $0 <slug> <cred-path>}"
validate_slug "$slug"

tunnel_name="wcn-cloud-${slug}"
tunnel_secret=$(openssl rand -base64 32 | tr -d '=+/' | head -c 40)

info "Creating tunnel '$tunnel_name'"

response=$(cf_api POST "/accounts/${CF_ACCOUNT_ID}/cfd_tunnel" "$(jq -nc \
  --arg name "$tunnel_name" \
  --arg secret "$(echo -n "$tunnel_secret" | base64 -w0)" \
  '{name: $name, tunnel_secret: $secret, config_src: "cloudflare"}')")

cf_api_ok "$response" || die "Tunnel create failed: $response"

tunnel_id=$(jq -r '.result.id' <<<"$response")
account_tag=$(jq -r '.result.account_tag' <<<"$response")

# The tunnel credentials JSON used by cloudflared on the VM.
jq -nc \
  --arg AccountTag "$account_tag" \
  --arg TunnelID "$tunnel_id" \
  --arg TunnelSecret "$(echo -n "$tunnel_secret" | base64 -w0)" \
  --arg TunnelName "$tunnel_name" \
  '{AccountTag: $AccountTag, TunnelID: $TunnelID, TunnelSecret: $TunnelSecret, TunnelName: $TunnelName}' \
  > "$cred_path"
chmod 600 "$cred_path"

ok "Tunnel ${tunnel_id} created, credentials at ${cred_path}"

# Configure ingress: route the customer's <slug>.app.* host to localhost:80 on the VM (Caddy).
config_body=$(jq -nc \
  --arg hostname "${slug}.app.western-communication.com" \
  '{config: {ingress: [
    {hostname: $hostname, service: "http://localhost:80"},
    {service: "http_status:404"}
  ]}}')

response=$(cf_api PUT "/accounts/${CF_ACCOUNT_ID}/cfd_tunnel/${tunnel_id}/configurations" "$config_body")
cf_api_ok "$response" || die "Tunnel ingress config failed: $response"

ok "Ingress rules configured"
echo "$tunnel_id"
