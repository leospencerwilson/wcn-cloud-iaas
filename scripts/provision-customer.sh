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
# Per the subdomain-per-service pivot (03dc5ae) each customer gets 4 records,
# all CNAME'd to the same cloudflared tunnel hostname. Caddy on the VM
# dispatches by Host header to the right upstream.
info "[4/9] Creating DNS records (apex + 3 service subdomains)..."
for record_name in \
  "${SLUG}.western-communication.com" \
  "admin-${SLUG}.western-communication.com" \
  "db-${SLUG}.western-communication.com" \
  "api-${SLUG}.western-communication.com"; do
  existing_dns=$(cf_api GET "/zones/${CF_ZONE_ID}/dns_records?name=${record_name}" \
    | jq -r '.result[0].id // empty')
  if [[ -n "$existing_dns" ]]; then
    info "  ${record_name} exists ($existing_dns)"
  else
    body=$(jq -nc \
      --arg name "$record_name" \
      --arg content "${TUNNEL_ID}.cfargotunnel.com" \
      '{type: "CNAME", name: $name, content: $content, proxied: true, ttl: 1}')
    response=$(cf_api POST "/zones/${CF_ZONE_ID}/dns_records" "$body")
    cf_api_ok "$response" || die "DNS create failed for ${record_name}: $response"
    ok "  ${record_name} created"
  fi
done
ok "[4/9] DNS records ready"

# ── 5. clone Proxmox VM ───────────────────────────────────────────────
if pve_api GET "/nodes/dreadnaught/qemu/${VMID}/status/current" \
   | jq -e '.data.status' >/dev/null 2>&1; then
  info "[5/9] VM ${VMID} already exists"
else
  info "[5/9] Cloning template ${TEMPLATE_VMID:-9002} → VMID ${VMID} (this takes ~3 min)..."
  pssh root@"$PROXMOX_HOST" "qm clone ${TEMPLATE_VMID:-9002} ${VMID} --name wcn-cloud-${SLUG} --full" \
    || die "Clone failed"
  ok "[5/9] Cloned"
fi

# ── 6. configure VM ───────────────────────────────────────────────────
info "[6/9] Configuring VM (cloud-init)..."
pssh root@"$PROXMOX_HOST" bash -s <<EOF
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
  pssh root@"$PROXMOX_HOST" "qm start ${VMID}"
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

# Generate the per-VM Supabase env (secrets+JWTs); also writes db_password
# back to ops_db.vms.db_password as a side effect.
"$HERE/render-customer-env.sh" --target supabase \
  --slug "$SLUG" --tier "$TIER" --name "$NAME" \
  --email "$EMAIL" --domain "$DOMAIN" \
  --tunnel-id "$TUNNEL_ID" --brand-colour "$BRAND_COLOUR" \
  --ip "$IP" \
  > "/tmp/supabase-${SLUG}.env"

pscp -q "/tmp/customer-${SLUG}.env" "ops@${IP}:/tmp/customer.env"
pscp -q "/tmp/supabase-${SLUG}.env" "ops@${IP}:/tmp/supabase.env"
[[ -f "$CRED_PATH" ]] && pscp -q "$CRED_PATH" "ops@${IP}:/tmp/cf-cred.json"

pssh ops@"$IP" 'sudo install -m 600 -o root -g root /tmp/customer.env /etc/wcn-cloud/customer.env && \
                  sudo install -m 600 -o root -g root /tmp/supabase.env /etc/wcn-cloud/supabase.env && \
                  if [[ -f /tmp/cf-cred.json ]]; then \
                    sudo install -m 600 -o root -g root /tmp/cf-cred.json /etc/wcn-cloud/cf-cred.json; \
                  fi && \
                  sudo systemctl start wcn-firstboot.service && \
                  sudo systemctl status wcn-firstboot.service --no-pager'
ok "[8/9] Firstboot complete"

# scrub local tmp files (they contain secrets)
rm -f "/tmp/customer-${SLUG}.env" "/tmp/supabase-${SLUG}.env"

# ── 9. health check + finalise ────────────────────────────────────────
# Auth is enforced by the WCN console (Caddy forward_auth → /api/verify),
# not Cloudflare Access. No per-customer CF Access apps to create.
info "[9/9] Health check..."
sleep 10
"$HERE/customer-health-check.sh" "$SLUG" || die "Health check failed — investigate"


# ── 10. Coolify bootstrap — SSH keys, root team, service account, token
# Coolify v4's localhost server only works after ProductionSeeder runs
# AND its SSH keypair's public key is in the host's authorized_keys.
# Our service-account user joins the root Team 0 (so the API token
# scoped to team 0 can see Server 0 + projects in that team).
info "[10/11] Bootstrapping Coolify (SSH keys + root team + service account)..."

# Step 10a: SSH key, authorized_keys, User 0 + Team 0, ProductionSeeder
pssh ops@"$IP" sudo bash -s <<'SETUP_EOF'
set -e

# 1. Coolify localhost SSH keypair (host side). If a key file already
#    exists, leave it alone.
KEY_PATH=/data/coolify/ssh/keys/id.root@host.docker.internal
mkdir -p /data/coolify/ssh/keys
chmod 700 /data/coolify/ssh/keys
if [[ ! -f "$KEY_PATH" ]]; then
  ssh-keygen -t ed25519 -f "$KEY_PATH" -N '' -q -C 'coolify'
fi
chmod 600 "$KEY_PATH"
chmod 644 "${KEY_PATH}.pub"

# 2. Pubkey into host root's authorized_keys
mkdir -p /root/.ssh
chmod 700 /root/.ssh
touch /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
PUB=$(cat "${KEY_PATH}.pub")
if ! grep -qF "$PUB" /root/.ssh/authorized_keys; then
  echo "$PUB" >> /root/.ssh/authorized_keys
fi

# 3. User 0 + Team 0 + team_user pivot. ProductionSeeder gates its
#    team_user insert on both existing — we provide them.
docker exec coolify-db psql -U coolify -c "
INSERT INTO teams (id, name, personal_team, created_at, updated_at)
  VALUES (0, 'Root Team', false, now(), now())
  ON CONFLICT (id) DO NOTHING;
INSERT INTO users (id, name, email, password, email_verified_at, created_at, updated_at)
  VALUES (0, 'Root User', 'wcn-root@western-communication.com',
          '\$2y\$12\$placeholder.hash.do.not.use.for.login.....................',
          now(), now(), now())
  ON CONFLICT (id) DO NOTHING;
INSERT INTO team_user (team_id, user_id, role, created_at, updated_at)
  VALUES (0, 0, 'owner', now(), now())
  ON CONFLICT DO NOTHING;
SELECT setval(pg_get_serial_sequence('users','id'), GREATEST(1, (SELECT MAX(id) FROM users)));
SELECT setval(pg_get_serial_sequence('teams','id'), GREATEST(1, (SELECT MAX(id) FROM teams)));
"

# 4. ProductionSeeder — creates PrivateKey 0, Server 0, StandaloneDocker 0
docker exec coolify php artisan db:seed --class=ProductionSeeder --force

# 5. Force server 0 settings (defensive — ServerCheckJob may flip them)
docker exec coolify-db psql -U coolify -c "
UPDATE server_settings SET is_reachable = true, is_usable = true, force_disabled = false WHERE server_id = 0;
"

# 6. If ProductionSeeder generated its own key (different from ours),
#    derive its pubkey and add to authorized_keys too — both should work.
KEY0_UUID=$(docker exec coolify-db psql -U coolify -t -A -c "SELECT uuid FROM private_keys WHERE id = 0")
if [[ -n "$KEY0_UUID" ]]; then
  PUB2=$(docker exec coolify ssh-keygen -y -f /var/www/html/storage/app/ssh/keys/ssh_key@$KEY0_UUID 2>/dev/null || true)
  if [[ -n "$PUB2" ]] && ! grep -qF "$PUB2" /root/.ssh/authorized_keys; then
    echo "$PUB2" >> /root/.ssh/authorized_keys
  fi
fi
SETUP_EOF

# Step 10b: wcn-service user as member of team 0, API token scoped to
# team 0, default project + environment in team 0.
coolify_bootstrap_script=$(cat <<'PHP'
\App\Models\InstanceSettings::get()->update(['is_api_enabled' => true]);
$email = 'wcn-service@western-communication.com';
$u = \App\Models\User::where('email', $email)->first();
if (!$u) {
  $u = new \App\Models\User();
  $u->name = 'WCN Service Account';
  $u->email = $email;
  $u->password = bcrypt(\Str::random(64));
  $u->email_verified_at = now();
  $u->save();
}
if (!\DB::table('team_user')->where('team_id', 0)->where('user_id', $u->id)->exists()) {
  \DB::table('team_user')->insert(['team_id' => 0, 'user_id' => $u->id, 'role' => 'admin', 'created_at' => now(), 'updated_at' => now()]);
}
\DB::table('personal_access_tokens')->where('tokenable_id', $u->id)->where('name', 'wcn-console')->delete();
$entropy = \Str::random(40);
$plain   = $entropy . hash('crc32b', $entropy);
$hashed  = hash('sha256', $plain);
$tid = \DB::table('personal_access_tokens')->insertGetId([
  'name' => 'wcn-console', 'token' => $hashed,
  'abilities' => json_encode(['read','write','deploy']),
  'tokenable_id' => $u->id, 'tokenable_type' => 'App\\Models\\User',
  'team_id' => 0, 'expires_at' => null,
  'created_at' => now(), 'updated_at' => now(),
]);
$project = \App\Models\Project::where('team_id', 0)->first();
if (!$project) {
  $project = new \App\Models\Project();
  $project->uuid = (string) \Illuminate\Support\Str::uuid();
  $project->name = 'Default';
  $project->description = 'Default project — created by WCN provisioner';
  $project->team_id = 0;
  $project->save();
}
$env = \App\Models\Environment::where('project_id', $project->id)->first();
if (!$env) {
  $env = new \App\Models\Environment();
  $env->uuid = (string) \Illuminate\Support\Str::uuid();
  $env->name = 'production'; $env->project_id = $project->id;
  $env->save();
}
echo 'WCN_COOLIFY_API_TOKEN=' . $tid . '|' . $plain . "\n";
PHP
)
# Push the PHP via stdin and require it inside the coolify container.
# Passing the multi-line script as `--execute="$var"` through ssh fails:
# ssh joins args with spaces but does not re-quote, so embedded newlines
# become command separators on the remote shell and the bootstrap silently
# fails (stderr was swallowed). Writing to a file avoids the quoting layers.
{ printf '<?php\n'; printf '%s' "$coolify_bootstrap_script"; } \
  | pssh ops@"$IP" "cat > /tmp/wcn-${SLUG}-bootstrap.php" \
  || die "Could not stage bootstrap PHP on $IP"
coolify_token=$(pssh ops@"$IP" "sudo docker cp /tmp/wcn-${SLUG}-bootstrap.php coolify:/tmp/wcn-bootstrap.php && sudo docker exec coolify php artisan tinker --execute=\"require '/tmp/wcn-bootstrap.php';\"" 2>&1 \
  | grep -oE 'WCN_COOLIFY_API_TOKEN=[0-9]+\|[A-Za-z0-9]+' | cut -d= -f2)
pssh ops@"$IP" "rm -f /tmp/wcn-${SLUG}-bootstrap.php; sudo docker exec coolify rm -f /tmp/wcn-bootstrap.php" >/dev/null 2>&1 || true
[[ -n "$coolify_token" ]] || die "Coolify token bootstrap failed (no token in tinker output)"
ops_db -c "UPDATE vms SET coolify_api_token='${coolify_token}' WHERE customer_slug='$SLUG'" >/dev/null
ok "[10/11] Coolify bootstrap complete (token tid=${coolify_token%%|*})"


# ── 11. Metrics rollout (node_exporter + cAdvisor + Prometheus target)
info "[11/11] Installing metrics exporters..."
"${HERE}/install-metrics.sh" --slug "$SLUG" || warn "metrics install failed (non-fatal)"

ops_db -c "UPDATE customers SET status='active' WHERE slug='$SLUG'"
ops_db_audit "provision-done" "$SLUG" "vmid=$VMID, ip=$IP, tunnel=$TUNNEL_ID"

# Cleanup local cred file
rm -f "$CRED_PATH" "/tmp/customer-${SLUG}.env"

ok "[9/9] All checks passed"

cat <<SUMMARY

✅ Customer '${SLUG}' provisioned successfully.

   Apps:      https://${SLUG}.western-communication.com
   Coolify:   https://admin-${SLUG}.western-communication.com
   Studio:    https://db-${SLUG}.western-communication.com
   API:       https://api-${SLUG}.western-communication.com
   Admin:     ${EMAIL}  (signs in via the WCN console)

Next steps:
  • Send the welcome email (template: runbooks/new-customer.md)
  • When customer's ready, run:
      ./scripts/add-custom-domain.sh --slug ${SLUG} --domain ${DOMAIN}

SUMMARY
