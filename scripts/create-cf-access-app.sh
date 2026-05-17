#!/usr/bin/env bash
# Create a Cloudflare Access app + policy for a customer path.
#
# Usage: create-cf-access-app.sh <slug> <path> <admin-email> [<extra-email>...]
#   e.g.: create-cf-access-app.sh acme /coolify admin@acme.com
#
# Stdout: app UUID

source "$(dirname "$0")/common.sh"
require_env CF_API_TOKEN CF_ACCOUNT_ID CF_ZONE_ID CF_ENTRA_IDP_ID
require_cmd curl jq

slug="${1:?Usage: $0 <slug> <path> <admin-email> [more emails...]}"
path="${2:?path required, e.g. /coolify}"
admin_email="${3:?admin email required}"
shift 3
extra_emails=("$@")

validate_slug "$slug"
validate_email "$admin_email"

domain="${slug}.western-communication.com"
app_name="wcn-cloud-${slug}-${path//\//}"

info "Creating Access app '${app_name}' for ${domain}${path}"

# 1. Create the application.
app_body=$(jq -nc \
  --arg name "$app_name" \
  --arg domain "${domain}${path}" \
  --arg type "self_hosted" \
  --arg session "24h" \
  --arg idp "$CF_ENTRA_IDP_ID" \
  '{name: $name, domain: $domain, type: $type, session_duration: $session,
    allowed_idps: [$idp], auto_redirect_to_identity: true,
    app_launcher_visible: false}')

response=$(cf_api POST "/accounts/${CF_ACCOUNT_ID}/access/apps" "$app_body")
cf_api_ok "$response" || die "Access app create failed: $response"

app_id=$(jq -r '.result.id' <<<"$response")
ok "App created: $app_id"

# 2. Build the policy include block.
includes=( "$(jq -nc --arg e "$admin_email" '{email: {email: $e}}')" )
for e in "${extra_emails[@]}"; do
  validate_email "$e"
  includes+=( "$(jq -nc --arg e "$e" '{email: {email: $e}}')" )
done

# Always allow ops staff (us).
includes+=( '{"email_domain": {"domain": "westerncommunication.co.uk"}}' )

includes_json=$(printf '%s\n' "${includes[@]}" | jq -sc .)

policy_body=$(jq -nc \
  --argjson include "$includes_json" \
  '{name: "default", decision: "allow", include: $include}')

response=$(cf_api POST "/accounts/${CF_ACCOUNT_ID}/access/apps/${app_id}/policies" "$policy_body")
cf_api_ok "$response" || die "Access policy create failed: $response"

ok "Policy attached"
echo "$app_id"
