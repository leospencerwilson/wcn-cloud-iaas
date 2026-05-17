# Phase 0 — Prerequisites

**Goal:** every account, credential, and decision needed for phases 1+ is in hand. No infrastructure changes yet.

**Estimated time:** half a day, mostly waiting for account verifications.

**Prerequisites:** none.

---

## 0.1 Decisions to lock

Make these now and commit them. Changing later is painful.

| Decision | Recommended value | Locked? |
|---|---|---|
| Product name | **WCN Cloud** | ✅ |
| Sales site (existing) | `westerncommunication.co.uk` (out of scope — already live) | ✅ |
| Console URL | `console.western-communication.com` | ✅ |
| Default customer subdomain | `*.western-communication.com` | ✅ |
| Status page URL | `status.western-communication.com` | ✅ |
| Customer-facing support email | `cloud-support@western-communication.com` | ✅ |
| Brand primary colour | (extract from sales site — see § 0.5) | ⬜ |
| Brand secondary colour | (extract from sales site — see § 0.5) | ⬜ |
| Logo files in `branding/` | logo.svg, wordmark.svg, favicon.png | ⬜ |

## 0.2 Accounts to create

### Backblaze B2 (offsite backups)

1. Sign up at https://www.backblaze.com/cloud-storage
2. Create a bucket: `wcn-cloud-backups`, private, lifecycle = "keep all versions"
3. Create an Application Key:
   - Name: `wcn-cloud-backups-rw`
   - Allow access to: `wcn-cloud-backups` (only)
   - Type of access: Read and Write
   - File name prefix: blank (full bucket access)
4. Copy `keyID` and `applicationKey` — both must be saved to your password vault.

### Monitoring (internal Proxmox VM + Cloudflare Health Checks)

> **Substitution from original plan:** the original design called for a Hetzner VPS as an off-site monitoring vantage point. Instead we split monitoring into two pieces:
> - **External liveness:** Cloudflare Health Checks (free, account-level) probes our public endpoints from CF's global network. This is what pages us when Dreadnaught is down — it cannot itself go down with us.
> - **Internal dashboards:** a small Proxmox VM (`wcn-monitor`) on `vlan30` (DMZ) running Uptime Kuma + Grafana + Prometheus. Used by ops for trend data, not for "is it alive" alerting.
>
> Trade-off: when Dreadnaught is down, the dashboards are also down. CF Health Checks still alert externally, so we know about the outage. Acceptable for a single-DC posture; revisit at phase 7 (scale) when adding a second DC.

#### Step 1 — Create the Proxmox monitor VM

This step happens in **phase 1** (after the foundations VLAN is in place). For now, just reserve the IP and hostname:

| Field | Value |
|---|---|
| Hostname | `wcn-monitor` |
| VMID | `110` |
| IP | `10.10.30.20/24` (DMZ — `vlan30`) |
| Specs | 2 vCPU / 2 GB RAM / 20 GB disk |
| OS | Debian 12 |

#### Step 2 — Configure Cloudflare Health Checks

Done from the Cloudflare dashboard in phase 1 once DNS records exist. For phase 0, just confirm the feature is available in your CF plan:

1. Cloudflare dashboard → `western-communication.com` zone → Traffic → Health Checks
2. Verify "Create" is enabled (Health Checks are free on all plans).
3. Note the notification email(s) we will alert to (default: `cloud-support@western-communication.com`).

### Cloudflare API token

1. Cloudflare dashboard → My Profile → API Tokens → Create Token → Custom token
2. Permissions:
   - **Zone** → Zone Settings → Read
   - **Zone** → Zone → Read
   - **Zone** → DNS → Edit
   - **Zone** → SSL and Certificates → Edit
   - **Zone** → SSL and Certificates → Read
   - **Account** → Cloudflare Tunnel → Edit
   - **Account** → Access: Apps and Policies → Edit
   - **Account** → Access: Service Tokens → Edit
3. Zone Resources: Include → Specific zone → `western-communication.com`
4. Account Resources: Include → Specific account → `Western Communication`
5. Save the token. Save it once — Cloudflare won't show it again.

### Cloudflare for SaaS

1. Cloudflare dashboard → `western-communication.com` zone → SSL/TLS → Custom Hostnames
2. Click "Enable" — this turns on Cloudflare for SaaS for the zone.
3. Configure the **Fallback Origin**:
   - Hostname: `fallback.western-communication.com`
   - We'll add the DNS record in phase 1.
4. Note: this is free for up to 100 custom hostnames.

## 0.3 Tooling on your workstation

Install these locally (Windows + WSL or native):

```bash
# jq — JSON parsing in scripts
sudo apt install -y jq

# rclone — talks to B2
curl https://rclone.org/install.sh | sudo bash

# psql — for the ops DB
sudo apt install -y postgresql-client

# ssh, scp — assumed already present
```

Plus these on the Proxmox host (most are already there):

```bash
# qm, pvesh — Proxmox VE built-ins
# jq is needed for the scripts to parse Proxmox API output
ssh root@192.168.50.50 'apt install -y jq curl'
```

## 0.4 Credential storage

Save in your password vault (Bitwarden / 1Password / Vaultwarden once we deploy it):

| Variable | Description |
|---|---|
| `CF_API_TOKEN` | Cloudflare API token from § 0.2 |
| `CF_ACCOUNT_ID` | From CF dashboard → right sidebar |
| `CF_ZONE_ID` | From CF dashboard → western-communication.com → right sidebar |
| `CF_ACCESS_AUD` | Will be set when we create the first Access app — leave blank for now |
| `CF_TEAM_DOMAIN` | `westerncommunication.cloudflareaccess.com` |
| `B2_KEY_ID` | Backblaze Application Key ID |
| `B2_APP_KEY` | Backblaze Application Key |
| `PROXMOX_HOST` | `192.168.50.50` |
| `PROXMOX_USER` | `root` |
| `PROXMOX_API_TOKEN` | (created in phase 1) |
| `MONITOR_VM_IP` | `10.10.30.20` (internal Proxmox VM, created in phase 1) |
| `CF_HEALTHCHECK_NOTIFY` | Email(s) Cloudflare Health Checks alerts on failure |
| `OPS_DB_URL` | `postgresql://wcn_ops:<pw>@10.10.30.10:5432/wcn_cloud_ops` (created in phase 1) |
| `SLACK_WEBHOOK` | (optional) Slack incoming webhook for alerts |

## 0.5 Branding files

Place finalised brand assets at:

```
C:\Users\LeoWilson\server project\branding\
├── logo.svg
├── logo-mono.svg
├── wordmark.svg
├── favicon.png            (32x32)
├── favicon-192.png        (192x192)
├── og-image.png           (1200x630, for OpenGraph previews)
├── colours.css            (CSS variables for primary/secondary/etc.)
└── product-name.txt       (the name as a single line of text)
```

These get copied into the template VM during phase 2.

## 0.6 Acceptance

Sprint 0 is done when **all five** are true:

```bash
# 1. Cloudflare API token works
curl -s -H "Authorization: Bearer $CF_API_TOKEN" \
  https://api.cloudflare.com/client/v4/user/tokens/verify \
  | jq .success
# expected: true

# 2. B2 credentials work
rclone lsd b2:wcn-cloud-backups
# expected: empty bucket listing, no error

# 3. Cloudflare Health Checks feature is reachable on the account
curl -s -H "Authorization: Bearer $CF_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/healthchecks" \
  | jq .success
# expected: true (empty result is fine — we create the checks in phase 1)

# 4. Cloudflare for SaaS is enabled
curl -s -H "Authorization: Bearer $CF_API_TOKEN" \
  https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/custom_hostnames \
  | jq .success
# expected: true (empty result is fine)

# 5. Branding files exist
ls "C:/Users/LeoWilson/server project/branding/"
# expected: logo.svg, wordmark.svg, favicon.png, etc.
```

## 0.7 Rollback

Phase 0 makes no infrastructure changes. To "roll back":
- Delete the Backblaze bucket (5 min) — if used
- Revoke the Cloudflare API token
- Disable Cloudflare for SaaS
- Delete any Cloudflare Health Checks that were created
- The `wcn-monitor` Proxmox VM is created in phase 1, not phase 0 — nothing to roll back here

No cost, no impact.

---

**Next:** `phases/01-foundations.md`
