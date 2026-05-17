# Phase 1 — Foundations

**Goal:** the supporting infrastructure (offsite backups, monitoring, customer VLAN, ops database) is in place before we start building customer VMs.

**Estimated time:** 1 day.

**Prerequisites:** phase 0 acceptance complete.

---

## 1.1 MikroTik — add VLAN 31 for customers

This is the **only** phase that touches the live WCN production MikroTik. Read `CLAUDE.md` § "Critical constraints" before starting. **Safe Mode mandatory.**

### Pre-flight

1. Take a fresh export: `/export show-sensitive=no file=pre-vlan31-$(date -I)`
2. Download it: `scp` to your workstation, store next to `pre-dread-backup-20260430.rsc`
3. Open Winbox, connect to `192.168.100.240`
4. **Press Ctrl-X to enter Safe Mode** before pasting any config
5. Drop a note in `/system note set note="Adding VLAN 31 for customer hosting — Leo @ $(date -I)"`

### Apply

Paste the contents of `IaaS/configs/mikrotik-vlan31.rsc` into a New Terminal window.

What it does:
- Adds VLAN interface `vlan31_customers` (tag 31) on `bridge_flat`
- Adds bridge VLAN entry: tag 31, untagged none, tagged ether9 + bridge
- Adds IP address `10.10.31.1/24` on `vlan31_customers`
- Adds DHCP pool `customers_pool` (10.10.31.10–10.10.31.200)
- Adds DHCP server on `vlan31_customers`
- Adds firewall filter rules:
  - `vlan31 → vlan10 drop` (no mgmt access)
  - `vlan31 → vlan30 drop` (no DMZ access)
  - `vlan31 → vlan31 drop` (no customer-to-customer)
  - `vlan31 → established/related accept`
  - `vlan31 → out wan accept` (internet egress)

### Verify

```bash
# from another customer-mode device, ping should fail by design
ping 10.10.31.1
# expected: timeout (firewall drop)

# from a Proxmox console with a vlan31-tagged interface, get DHCP
ip a show dev vlan31
# expected: 10.10.31.X address from the pool
```

### Confirm with Jake

Send Jake the diff (`pre-vlan31-...rsc` vs current export) so he has visibility before the next ops review.

### Rollback

If anything looks wrong:
- Type `Ctrl-X` again to exit Safe Mode without committing — **all changes revert**.
- If already committed: `/import file-name=pre-vlan31-2026-05-08.rsc` (the file you took at the start)

## 1.2 Proxmox — bridge for VLAN 31

**Live-state finding (2026-05-15):** `vmbr1` on the Proxmox host is already VLAN-aware with `bridge-vids 2-4094`, backed by `nic1`, cabled as the trunk to MikroTik ether10. Customer VMs attach to `vmbr1` with `tag=31`.

**Gotcha discovered 2026-05-15:** `bridge-vids 2-4094` applies to slave ports only. The bridge's "self" port (the egress point for `vmbr<N>.<vid>` sub-interfaces and any L3 the host needs on a tagged VLAN) must have VIDs added separately, or ingress filtering silently drops outbound tagged frames. Symptom: outbound ARP doesn't reach the wire, neighbour stays INCOMPLETE.

Fix is one `post-up` line on `vmbr1` in `/etc/network/interfaces`:

```
post-up /usr/sbin/bridge vlan add vid 2-4094 dev vmbr1 self
```

`vmbr0` is the mgmt interface (untagged, mgmt VLAN only) and should not be touched.

```bash
ssh root@192.168.50.50

# Verify VID 31 is in vmbr1's allowed range
bridge vlan show dev vmbr1 | grep -E "^31\b|\s31\b" | head -3

# End-to-end wire test (Proxmox host can hit the VLAN 31 gateway via nic1 → ether10)
ip link add link nic1 name nic1.31 type vlan id 31
ip link set nic1.31 up
ip addr add 10.10.31.99/24 dev nic1.31
ping -c 3 10.10.31.1
# expected: 3/3 replies from 10.10.31.1
ip addr del 10.10.31.99/24 dev nic1.31
ip link del nic1.31
```

When we clone a customer VM in phase 3, we set the network device with `bridge=vmbr1,tag=31`.

## 1.3 Ops database — Postgres on the existing Coolify VM

Our metadata about who-is-who, what-is-deployed-where, and tunnel IDs lives in a small Postgres DB on the existing Coolify VM (10.10.30.10). It's small (~10 MB ever), but it's the source of truth for the console UI.

### Create the database

```bash
ssh ops@10.10.30.10

# Use the Postgres already running for our own Supabase stack.
# Create a separate DB so it doesn't pollute the Supabase one.
docker exec -it $(docker ps -q -f name=postgres -f label=coolify.managed) bash -c "
  psql -U postgres -c 'CREATE USER wcn_ops WITH PASSWORD '\''<generate-strong>'\'';' &&
  psql -U postgres -c 'CREATE DATABASE wcn_cloud_ops OWNER wcn_ops;'
"
```

Save the password into your vault as `OPS_DB_PASSWORD` and update `OPS_DB_URL`.

### Apply the schema

```bash
psql "$OPS_DB_URL" < IaaS/configs/ops-db-schema.sql
```

The schema lives in `configs/ops-db-schema.sql` and has 4 tables:

- `customers` — slug, name, tier, contact email, brand colours, status
- `vms` — vmid, customer slug, IP, tunnel UUID, hostnames, status
- `domains` — custom hostname, customer slug, CF custom hostname ID, validation status
- `audit_log` — every provisioning action, who did it, when, with what params

### Smoke-test

```bash
psql "$OPS_DB_URL" -c '\dt'
# expected: 4 tables listed
```

## 1.4 Backups — B2 destination + first nightly job

### Configure rclone on the Coolify VM

```bash
ssh ops@10.10.30.10

# rclone is already installed (assumed) — if not:
# curl https://rclone.org/install.sh | sudo bash

mkdir -p ~/.config/rclone
cat > ~/.config/rclone/rclone.conf <<EOF
[b2]
type = b2
account = ${B2_KEY_ID}
key = ${B2_APP_KEY}
hard_delete = false
EOF
chmod 600 ~/.config/rclone/rclone.conf

rclone lsd b2:wcn-cloud-backups
# expected: empty bucket listing
```

### Install the backup orchestrator

Copy `IaaS/scripts/backup-supabase.sh` to `/opt/wcn-cloud/bin/backup-supabase.sh` on the Coolify VM. Make executable.

Then add a cron entry:

```bash
sudo crontab -u ops -e
# add:
30 3 * * * /opt/wcn-cloud/bin/backup-supabase.sh >> /var/log/wcn-cloud/backup.log 2>&1
```

For phase 1, this only backs up **our own** Coolify VM's Supabase Postgres (the one hosting the ops DB). In phase 4, we'll generalise it to back up customer DBs too.

### Smoke-test

```bash
# manually run it once
sudo -u ops /opt/wcn-cloud/bin/backup-supabase.sh

# should output something like:
# [2026-05-08 14:32:00] Starting backup
# [2026-05-08 14:32:01] pg_dump → /tmp/wcn-cloud-backups/ops-db-20260508T143200.sql.gz (4.2 KB)
# [2026-05-08 14:32:02] rclone copy → b2:wcn-cloud-backups/ops/ ✓
# [2026-05-08 14:32:02] Done

rclone ls b2:wcn-cloud-backups/ops/
# expected: at least one .sql.gz
```

## 1.5 Monitoring — Cloudflare Health Checks + internal Proxmox VM

Two layers:

1. **External liveness alerting** — Cloudflare Health Checks, probing public endpoints from CF's global network. This is what pages us when Dreadnaught is down.
2. **Internal dashboards** — a small Proxmox VM (`wcn-monitor`) on VLAN 30 (DMZ) running Uptime Kuma + Grafana + Prometheus. Used by ops for trend data and detailed checks against internal services. Reachable only via Cloudflare Access.

### 1.5a — Create the `wcn-monitor` VM

From the Proxmox host:

```bash
ssh root@$PROXMOX_HOST

# Clone from the Debian 12 template we'll build in phase 2 — for now, do a quick install
qm create 110 \
  --name wcn-monitor \
  --memory 2048 --cores 2 \
  --net0 virtio,bridge=vmbr1,tag=30 \
  --ide2 local:iso/debian-12.5.0-amd64-netinst.iso,media=cdrom \
  --scsihw virtio-scsi-single --scsi0 local-lvm:20 \
  --boot order=ide2 --ostype l26

qm start 110
# Complete the Debian install via the Proxmox console:
#   - Static IP 10.10.30.20/24, gateway 10.10.30.1
#   - Hostname wcn-monitor
#   - Create user 'ops' with sudo + your SSH key
```

Once up:

```bash
ssh ops@10.10.30.20

# Docker + firewall
sudo apt update && sudo apt upgrade -y
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ops
sudo apt install -y ufw fail2ban
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow from 10.10.0.0/16 to any port 22 proto tcp
sudo ufw --force enable
```

### 1.5b — Deploy Uptime Kuma + Grafana via Docker Compose

Copy `IaaS/configs/monitor-compose.yml` to `/home/ops/monitor/docker-compose.yml`.

```bash
ssh ops@$MONITOR_VM_IP
cd ~/monitor
docker compose pull
docker compose up -d
```

Since the VM is internal-only, it does not need a public TLS cert. Access is via Cloudflare Tunnel + Cloudflare Access (see phase 6 for the tunnel setup; for now you can port-forward over SSH: `ssh -L 3001:localhost:3001 ops@$MONITOR_VM_IP`).

### 1.5c — Cloudflare Health Checks for external liveness

Create Health Checks for each public endpoint via the API (or the dashboard at Traffic → Health Checks). Example:

```bash
curl -s -X POST \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/healthchecks" \
  -d '{
    "name": "console",
    "address": "console.western-communication.com",
    "type": "HTTPS",
    "http_config": {
      "method": "GET",
      "path": "/",
      "port": 443,
      "expected_codes": ["200", "302"]
    },
    "interval": 60,
    "retries": 2,
    "timeout": 5,
    "check_regions": ["WEU", "ENAM"]
  }' | jq .
```

Repeat for any other publicly-reachable hostname (e.g. `app.western-communication.com` once the pilot is up).

Wire alerts: Cloudflare dashboard → Notifications → Add → "Health Check Status Notification" → notify `$CF_HEALTHCHECK_NOTIFY`.

### 1.5d — Status page (deferred to phase 6)

Public status page deferred. Two viable options when we get there:

- **Cloudflare Pages** — static HTML regenerated from inside the internal VM and pushed via API. Survives a DC outage.
- **External SaaS** (BetterStack, Statuspage) — also survives a DC outage; £0–£20/mo.

Until then, internal Uptime Kuma covers ops visibility and CF Health Check emails cover alerting.

### Smoke-test

```bash
# Internal dashboard reachable from inside the network
curl -s http://10.10.30.20:3001 -o /dev/null -w "%{http_code}\n"
# expected: 200 (or 302 to /setup on first run)

# Cloudflare Health Check exists
curl -s -H "Authorization: Bearer $CF_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/healthchecks" \
  | jq '.result | length'
# expected: >= 1
```

## 1.6 Proxmox API token (replaces using root password)

We never want our scripts to know root's password. Create a dedicated API token:

```bash
ssh root@192.168.50.50

# Create the user (Proxmox-internal, not Linux)
pveum user add provisioner@pve --comment "API user for WCN cloud provisioning"

# Give it the privileges needed to clone, network, start/stop, snapshot
pveum aclmod / -user provisioner@pve -role PVEVMAdmin
pveum aclmod /storage -user provisioner@pve -role PVEDatastoreUser
pveum aclmod /sdn -user provisioner@pve -role PVESDNUser

# Generate the token
pveum user token add provisioner@pve provisioner-token --privsep=0
# Output:
# token-id: provisioner@pve!provisioner-token
# value: 12345678-90ab-cdef-1234-567890abcdef
# Save BOTH to your vault as PROXMOX_API_TOKEN
```

Test from your workstation:

```bash
curl -k -H "Authorization: PVEAPIToken=$PROXMOX_API_TOKEN" \
  https://192.168.50.50:8006/api2/json/version | jq .data
# expected: {"release":"...","version":"9.0-X","repoid":"..."}
```

## 1.7 Acceptance

Phase 1 is done when **all six** are true:

```bash
# 1. VLAN 31 routes
mtr -c 5 10.10.31.1   # from anywhere on mgmt — expected: blocked (firewall)
                      # but customer-mode VMs should DHCP into 10.10.31.x

# 2. Ops DB has the schema
psql "$OPS_DB_URL" -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';"
# expected: 4

# 3. B2 has at least one backup
rclone ls b2:wcn-cloud-backups/ops/ | wc -l
# expected: ≥ 1

# 4. Monitor VPS is up
curl -fI https://status.western-communication.com
# expected: 200

# 5. Uptime Kuma reports green for our existing prod (super.dreadnaught + console)
# (visual check)

# 6. Proxmox API token works
curl -k -s -H "Authorization: PVEAPIToken=$PROXMOX_API_TOKEN" \
  https://192.168.50.50:8006/api2/json/version | jq .data.release
# expected: "9.0-X"
```

## 1.8 Rollback

Each component rolls back independently:

| Component | Rollback |
|---|---|
| MikroTik VLAN 31 | `/import pre-vlan31-2026-05-08.rsc` (5 min, but verify Safe Mode wasn't already committed) |
| Proxmox bridge | Remove `vmbr0.31` block from `/etc/network/interfaces`, `ifreload -a` |
| Ops DB | `DROP DATABASE wcn_cloud_ops; DROP USER wcn_ops;` |
| B2 backups | Disable cron, `rclone delete b2:wcn-cloud-backups` (only after confirming no customer data lives there yet — at this stage there isn't any) |
| Monitor VPS | `docker compose down`, then either keep the VM or destroy it |
| Proxmox token | `pveum user token remove provisioner@pve provisioner-token` |

---

**Next:** `phases/02-template-vm.md`
