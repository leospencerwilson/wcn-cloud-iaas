# Phase 2 — Template VM

**Goal:** a single golden Proxmox VM image (`tpl-coolify-supabase`, VMID 9001) that we'll clone for every customer in phase 3.

**Estimated time:** 1 day.

**Prerequisites:** phase 1 acceptance complete.

---

## 2.1 What goes in the template

A customer VM, before any customer customisation:

| Component | Purpose | Started by |
|---|---|---|
| Ubuntu 24.04 LTS | OS | itself |
| QEMU guest agent | Proxmox can talk to the guest | systemd |
| Cloud-init | First-boot config (hostname, IP, SSH key) | Proxmox |
| Docker + Compose | Container runtime | systemd |
| Coolify | PaaS engine — handles git deploys, env vars, DBs | systemd (`coolify.service`) |
| Caddy | Lock-down reverse proxy | systemd (`caddy.service`) |
| cloudflared | Per-customer Cloudflare Tunnel | systemd (`cloudflared.service`) |
| Branding files | logo.svg, colours.css, etc. | copied to `/etc/wcn-cloud/branding/` |
| `customer.env` template | Slug, name, brand, contacts | dropped at `/etc/wcn-cloud/customer.env.dist` |
| `wcn-cloud-firstboot.sh` | Idempotent first-boot script that wires up Coolify, Caddy, cloudflared from `customer.env` | oneshot systemd unit |

Everything that can be **identical across customers** lives in the template. Everything **per-customer** (slug, IP, brand, tunnel UUID) is parameterised through `customer.env`, which we render at provision time.

## 2.2 Build the base VM

On the Proxmox host:

```bash
ssh root@192.168.50.50

# Get Ubuntu 24.04 cloud image
mkdir -p /var/lib/vz/template/iso/cloud
cd /var/lib/vz/template/iso/cloud
wget -O ubuntu-24.04.img https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img

# Create the template shell
qm create 9001 \
  --name tpl-coolify-supabase \
  --memory 8192 \
  --cores 4 \
  --cpu cputype=host \
  --net0 virtio,bridge=vmbr1,tag=31 \
  --serial0 socket --vga serial0 \
  --scsihw virtio-scsi-single \
  --boot c --bootdisk scsi0 \
  --agent enabled=1 \
  --ostype l26

# Import the cloud image as the disk
qm importdisk 9001 /var/lib/vz/template/iso/cloud/ubuntu-24.04.img local-lvm
qm set 9001 --scsi0 local-lvm:vm-9001-disk-0,discard=on,iothread=1,ssd=1

# Resize disk to 60 GB (default cloud image is 2 GB)
qm resize 9001 scsi0 60G

# Cloud-init drive
qm set 9001 --ide2 local-lvm:cloudinit
```

## 2.3 First-boot the VM (one-time, manual)

We need to boot the VM once to install software and bake in our scripts.

```bash
# Set a temporary cloud-init user/key/IP for the build
qm set 9001 \
  --ciuser ops \
  --cipassword "$(openssl rand -base64 16)" \
  --sshkeys ~/.ssh/authorized_keys \
  --ipconfig0 ip=10.10.31.250/24,gw=10.10.31.1 \
  --nameserver "1.1.1.1 1.0.0.1"

qm start 9001

# Wait for it to come up, then SSH
sleep 30
ssh ops@10.10.31.250
```

## 2.4 Run the template setup script

Copy `IaaS/scripts/setup-template.sh` to the VM and run it.

```bash
# from your workstation
scp IaaS/scripts/setup-template.sh ops@10.10.31.250:/tmp/

# on the VM
ssh ops@10.10.31.250
sudo bash /tmp/setup-template.sh
```

What it does (full annotated source in `scripts/setup-template.sh`):

1. **System packages**: `apt update && apt install -y ca-certificates curl gnupg jq rsync htop ufw fail2ban unattended-upgrades`
2. **Docker**: official repo, install `docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin`
3. **UFW**: deny incoming except SSH (22) and HTTP (80, used by cloudflared origin); enable
4. **fail2ban**: SSH protection enabled
5. **Unattended security upgrades**: configured per `/etc/apt/apt.conf.d/50unattended-upgrades`
6. **Coolify**: `curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash`
   - Configures Coolify on `localhost:8000` (only — UFW blocks external access)
   - Disables Coolify's exposed dashboard port (we proxy via Caddy)
7. **Caddy**: official repo install. Drops a placeholder Caddyfile that 503's; the real one is rendered per-customer at first boot.
8. **cloudflared**: official repo install. No tunnel configured yet.
9. **WCN-Cloud directory**: creates `/etc/wcn-cloud/`, `/opt/wcn-cloud/bin/`, `/var/log/wcn-cloud/`
10. **firstboot.sh + systemd unit**: drops `/opt/wcn-cloud/bin/firstboot.sh` and `wcn-firstboot.service`. Runs on next boot, reads `customer.env`, configures Coolify admin password, Caddy site config, cloudflared tunnel — once.
11. **Branding directory**: creates `/etc/wcn-cloud/branding/` and copies in the assets from `/tmp/branding.tar.gz` (we scp this up before running the script)
12. **Cleanup**: `apt autoremove`, `apt clean`, truncate logs, remove SSH host keys (so each clone gets fresh ones)

Before running, scp the branding bundle:

```bash
# on workstation
tar -czf /tmp/branding.tar.gz -C "C:/Users/LeoWilson/server project/branding" .
scp /tmp/branding.tar.gz ops@10.10.31.250:/tmp/
# then run setup-template.sh which expects /tmp/branding.tar.gz
```

## 2.5 Convert to template

After the script finishes, shut down the VM cleanly and convert:

```bash
# on the Proxmox host
qm shutdown 9001
# wait for it to stop
qm template 9001
```

The VM is now a Proxmox **template** — clones happen in seconds with linked clones (or longer with full clones).

## 2.6 Snapshot the template

```bash
qm snapshot 9001 v1-baseline --description "Initial template, $(date -I), Coolify $(date)"
```

When we update Coolify or Caddy in the template later, we snapshot a `v2-...` and roll customer VMs forward through `rolling-update.sh`.

## 2.7 Validate the template

Clone it once into a throwaway test VM:

```bash
# on the Proxmox host
qm clone 9001 999 --name test-clone --full

qm set 999 \
  --ciuser ops \
  --sshkeys /root/.ssh/authorized_keys \
  --ipconfig0 ip=10.10.31.249/24,gw=10.10.31.1

qm start 999

# Wait for boot
sleep 60

# SSH and check
ssh ops@10.10.31.249 << 'CHECK'
systemctl is-active docker
systemctl is-active caddy
systemctl is-active cloudflared        # should be inactive (no config yet)
docker ps                              # should show coolify containers
ls /etc/wcn-cloud/branding/ | wc -l    # ≥ 5 files
CHECK

# Cleanup
qm stop 999 && qm destroy 999 --purge
```

## 2.8 Acceptance

Phase 2 is done when **all four** are true:

1. `qm list | grep 9001` shows the template (status `running` = no, must be `stopped` post-template-conversion)
2. The throwaway clone in 2.7 boots and reports the systemd services as expected
3. Coolify on the clone responds at `localhost:8000` from inside the VM (`curl localhost:8000/api/v1/health` → 200)
4. The branding bundle was copied (`ls /etc/wcn-cloud/branding/` shows the SVGs/PNGs)

## 2.9 Rollback

```bash
# Destroy the template entirely
qm destroy 9001 --purge --destroy-unreferenced-disks 1
# (the test clone in §2.7 was already destroyed)
```

This phase is reversible at zero cost — no production state has been changed.

---

**Next:** `phases/03-provisioning.md`
