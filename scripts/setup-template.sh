#!/usr/bin/env bash
# Run *inside* a freshly-booted Ubuntu 24.04 cloud VM to bake in the
# WCN Cloud template. Idempotent.
#
# Usage:
#   sudo bash setup-template.sh
#
# Prereqs:
#   - /tmp/branding.tar.gz exists (logo, colours.css, etc.)

set -euo pipefail

log()  { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" >&2; }
ok()   { printf '[ OK] %s\n' "$*" >&2; }

[[ "$EUID" -eq 0 ]] || { echo "Run as root"; exit 1; }
[[ -f /tmp/branding.tar.gz ]] || { echo "Missing /tmp/branding.tar.gz"; exit 1; }

# ── 1. base packages ──────────────────────────────────────────────────
log "Installing base packages"
apt update
apt install -y ca-certificates curl gnupg jq rsync htop ufw fail2ban \
               unattended-upgrades qemu-guest-agent rclone postgresql-client
systemctl enable --now qemu-guest-agent
ok "Base packages"

# ── 2. UFW firewall ───────────────────────────────────────────────────
log "Configuring UFW"
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow from 10.10.31.0/24 to any port 80
ufw --force enable
ok "UFW"

# ── 3. fail2ban ────────────────────────────────────────────────────────
log "Configuring fail2ban"
cat >/etc/fail2ban/jail.d/sshd.conf <<EOF
[sshd]
enabled = true
maxretry = 5
bantime = 1h
EOF
systemctl restart fail2ban
ok "fail2ban"

# ── 4. unattended security upgrades ───────────────────────────────────
log "Configuring unattended-upgrades"
cat >/etc/apt/apt.conf.d/20auto-upgrades <<EOF
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
ok "unattended-upgrades"

# ── 5. Docker ──────────────────────────────────────────────────────────
log "Installing Docker"
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  > /etc/apt/sources.list.d/docker.list
apt update
apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
usermod -aG docker ops || true
ok "Docker"

# ── 6. Coolify ────────────────────────────────────────────────────────
log "Installing Coolify"
if ! [[ -d /data/coolify ]]; then
  curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash
fi
# Bind Coolify to localhost only — UFW + Caddy is the only external reachability.
if [[ -f /data/coolify/source/.env ]]; then
  sed -i 's/^APP_PORT=.*/APP_PORT=8000/' /data/coolify/source/.env
  sed -i 's/^APP_HOST=.*/APP_HOST=127.0.0.1/' /data/coolify/source/.env
fi
ok "Coolify"

# ── 7. Caddy ──────────────────────────────────────────────────────────
log "Installing Caddy"
apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | tee /etc/apt/sources.list.d/caddy-stable.list
apt update
apt install -y caddy
systemctl enable caddy
mkdir -p /var/log/caddy
chown caddy:caddy /var/log/caddy

# Placeholder Caddyfile — rendered properly at firstboot.
cat >/etc/caddy/Caddyfile <<'EOF'
:80 {
  respond "WCN Cloud — provisioning, please wait" 503
}
EOF
systemctl restart caddy
ok "Caddy"

# ── 8. cloudflared ────────────────────────────────────────────────────
log "Installing cloudflared"
mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  | tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] \
https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" \
  > /etc/apt/sources.list.d/cloudflared.list
apt update
apt install -y cloudflared
# Don't enable the service yet — needs config + creds first, applied at firstboot.
ok "cloudflared"

# ── 9. wcn-cloud directories + scripts ────────────────────────────────
log "Setting up /etc/wcn-cloud and /opt/wcn-cloud"
mkdir -p /etc/wcn-cloud /etc/wcn-cloud/branding /opt/wcn-cloud/bin /var/log/wcn-cloud
chown -R root:root /etc/wcn-cloud
chmod 755 /etc/wcn-cloud
chmod 700 /etc/wcn-cloud   # contains secrets after firstboot

# Install render-caddyfile.sh + its sourced helper common.sh into the VM
# (so Caddy can be re-rendered later — by firstboot.sh and add-custom-domain.sh).
for f in render-caddyfile.sh common.sh; do
  cp /tmp/$f /opt/wcn-cloud/bin/$f 2>/dev/null || \
    curl -fsSL https://raw.githubusercontent.com/wcn/iaas-bootstrap/main/$f \
      -o /opt/wcn-cloud/bin/$f
  chmod 755 /opt/wcn-cloud/bin/$f
done

# ── 10. branding ──────────────────────────────────────────────────────
log "Unpacking branding"
tar -xzf /tmp/branding.tar.gz -C /etc/wcn-cloud/branding
ok "Branding ($(ls /etc/wcn-cloud/branding | wc -l) files)"

# ── 11. firstboot service ─────────────────────────────────────────────
log "Installing firstboot script + systemd unit"

cat >/opt/wcn-cloud/bin/firstboot.sh <<'FIRSTBOOT'
#!/usr/bin/env bash
# Runs once per VM, after customer.env is in place.
# Idempotent — re-running is safe.
set -euo pipefail

ENV=/etc/wcn-cloud/customer.env
CRED=/etc/wcn-cloud/cf-cred.json
MARKER=/etc/wcn-cloud/.firstboot-done

[[ -f "$ENV" ]] || { echo "No customer.env yet — exiting"; exit 0; }
# shellcheck source=/dev/null
source "$ENV"

# Hostname
hostnamectl set-hostname "wcn-cloud-${SLUG}"
sed -i "s/^127.0.1.1.*/127.0.1.1\twcn-cloud-${SLUG}/" /etc/hosts || true

# Render Caddyfile from customer.env.
/opt/wcn-cloud/bin/render-caddyfile.sh "$ENV" > /etc/caddy/Caddyfile
# `systemctl reload caddy` validates the new config internally.
# Don't run an explicit `caddy validate` here: it would execute as root and
# open the access-log writer, creating /var/log/caddy/access.log root-owned,
# which then breaks reload (caddy.service runs as user caddy).
systemctl reload caddy

# Cloudflared: wire up tunnel using the credentials JSON.
if [[ -f "$CRED" && -n "${CLOUDFLARED_TUNNEL_ID:-}" ]]; then
  mkdir -p /etc/cloudflared
  install -m 600 -o root -g root "$CRED" "/etc/cloudflared/${CLOUDFLARED_TUNNEL_ID}.json"
  cat >/etc/cloudflared/config.yml <<YAML
tunnel: ${CLOUDFLARED_TUNNEL_ID}
credentials-file: /etc/cloudflared/${CLOUDFLARED_TUNNEL_ID}.json
no-autoupdate: true
ingress:
  - hostname: ${CONSOLE_HOSTNAME}
    service: http://localhost:80
  - service: http_status:404
YAML
  cloudflared service install || true
  systemctl enable --now cloudflared
fi

# Coolify: ensure it's started and admin email is set.
# Anchor the name filter — `name=coolify` matched coolify, coolify-db,
# coolify-redis, coolify-realtime, coolify-sentinel, returning multiple IDs
# which `docker exec` would parse as <container> <command>, failing.
docker exec $(docker ps -q -f 'name=^coolify$') bash -c "
  echo 'Setting Coolify admin email...'
" 2>/dev/null || true

# Done.
touch "$MARKER"
echo "Firstboot complete for $SLUG"
FIRSTBOOT
chmod 755 /opt/wcn-cloud/bin/firstboot.sh

cat >/etc/systemd/system/wcn-firstboot.service <<EOF
[Unit]
Description=WCN Cloud first-boot configuration
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/opt/wcn-cloud/bin/firstboot.sh
RemainAfterExit=true

[Install]
WantedBy=multi-user.target
EOF
# Don't enable yet — provisioner triggers it explicitly after customer.env is in place.
ok "firstboot service ready"

# ── 12. cleanup before snapshotting ──────────────────────────────────
log "Cleaning up for template"
apt autoremove -y
apt clean
rm -rf /var/lib/apt/lists/*
truncate -s 0 /var/log/*.log /var/log/**/*.log 2>/dev/null || true
rm -f /etc/ssh/ssh_host_*  # so each clone gets fresh keys
rm -f /tmp/branding.tar.gz /tmp/render-caddyfile.sh
cloud-init clean --logs --seed
echo > /etc/machine-id
ln -fs /var/lib/dbus/machine-id /etc/machine-id || true

ok "Template setup complete. Power off and convert to Proxmox template."
