# Phase 3 — Provisioning automation

**Goal:** a single command — `provision-customer.sh --slug acme --tier pro --domain acme.com --email admin@acme.com` — produces a fully-working customer VM in ≤30 minutes, with no manual steps.

**Estimated time:** 2 days.

**Prerequisites:** phase 2 acceptance complete.

---

## 3.1 What "fully-working" means

After `provision-customer.sh` returns successfully:

- A new Proxmox VM exists (next free VMID in 200–399, full clone of 9001)
- It boots with the correct `customer.env` already in place
- A Cloudflare Tunnel exists for it, with credentials baked into the VM
- DNS records exist on `*.western-communication.com` for the customer
- Coolify is accessible via Cloudflare Access at `https://<slug>.western-communication.com/coolify`
- Supabase Studio is accessible at `https://<slug>.western-communication.com/supabase`
- The customer is in the ops DB with status `active`
- The customer admin (`admin@acme.com`) has a Cloudflare Access policy granting them in
- An audit log row exists noting "provisioned by leo.wilson@... at <ts>"

The provisioning script does not do:
- Send a welcome email — that's the operator's job (template in `runbooks/new-customer.md`)
- Add a custom apex domain — that's `add-custom-domain.sh`, run separately when the customer is ready

## 3.2 The orchestrator: `provision-customer.sh`

Lives at `IaaS/scripts/provision-customer.sh`. ~250 lines of bash.

Flow:

```
parse-args
  ├─ slug          [required]   acme
  ├─ tier          [required]   site | site-db | pro
  ├─ domain        [required]   acme.com   (their primary domain — used for custom hostname later)
  ├─ email         [required]   admin@acme.com
  ├─ name          [required]   "Acme Ltd"
  └─ brand-colour  [optional]   #ff5500   (defaults from /etc/wcn-cloud/branding)

validate
  ├─ slug matches [a-z][a-z0-9-]{2,19}
  ├─ slug not taken in ops DB
  ├─ tier ∈ {site, site-db, pro}
  ├─ email is valid
  └─ ops DB reachable

allocate
  ├─ vmid    = SELECT next free VMID 200..399 from Proxmox + ops DB
  ├─ ip      = SELECT next free IP from 10.10.31.10..200 from ops DB
  └─ hostnames
       ├─ console hostname = <slug>.western-communication.com
       ├─ tunnel name      = wcn-cloud-<slug>
       └─ db backup prefix = b2:wcn-cloud-backups/<slug>/

create-tunnel (Cloudflare API)
  ├─ POST /accounts/{acct}/cfd_tunnel  → tunnel_id
  ├─ POST /accounts/{acct}/cfd_tunnel/{id}/configurations  (ingress rules)
  ├─ POST /zones/{zone}/dns_records  (CNAME slug.app → <tunnel_id>.cfargotunnel.com)
  └─ download cert → cert.json (this is what cloudflared on the VM will use)

clone-vm (Proxmox API)
  ├─ qm clone 9001 <vmid> --name wcn-cloud-<slug> --full
  ├─ qm set <vmid> --ipconfig0 ip=<ip>/24,gw=10.10.31.1
  ├─ qm set <vmid> --ciuser ops --sshkeys ~/.ssh/...
  └─ qm start <vmid>
  └─ wait for guest agent ready (qm guest agent ping with timeout)

push-customer-env (SSH)
  ├─ render customer.env from template (slug, name, tier, brand, contacts, tunnel cert)
  ├─ scp to /etc/wcn-cloud/customer.env
  ├─ scp tunnel-credentials.json to /etc/wcn-cloud/cf-cred.json
  └─ ssh "sudo systemctl start wcn-firstboot.service"
       (firstboot.sh reads customer.env, brings up Caddy + cloudflared + Coolify properly)

create-access-policies (Cloudflare API)
  ├─ POST /accounts/{acct}/access/apps  (one app per <slug>.* path /coolify)
  ├─ POST /accounts/{acct}/access/apps  (one app per <slug>.* path /supabase)
  └─ each with policy: include emails [admin email] and "ends with @westerncommunication.co.uk"

write-ops-db
  ├─ INSERT customers (slug, name, tier, email, brand_colour, status='provisioning')
  ├─ INSERT vms (vmid, customer_slug, ip, tunnel_id, console_hostname, ...)
  ├─ INSERT audit_log
  └─ UPDATE customers SET status='active' once health-check passes

health-check
  ├─ curl https://<slug>.western-communication.com/coolify/api/v1/health → 200 (after Access)
  ├─ curl https://<slug>.western-communication.com/supabase/api/health → 200
  └─ test in ops DB: SELECT count(*) FROM customers WHERE slug=$slug AND status='active' = 1

print-summary
  ├─ console URL
  ├─ admin email
  ├─ first-login instructions
  └─ next-step (welcome email + add-custom-domain.sh)
```

The script must be **idempotent**: re-running with the same `--slug` should detect the existing customer, skip already-completed steps, and resume from where it left off. (Exception: the slug-already-taken check fails fast — to re-run, use `--resume`.)

## 3.3 Sub-scripts the orchestrator calls

| Script | Purpose |
|---|---|
| `pick-next-ip.sh` | Returns next free customer IP, allocating in ops DB atomically |
| `pick-next-vmid.sh` | Same for VMID |
| `render-caddyfile.sh` | Generates the per-customer Caddyfile from a template, given slug + tier |
| `render-customer-env.sh` | Generates `customer.env` from a template |
| `create-cf-tunnel.sh` | One-shot — creates tunnel, returns ID + cert JSON |
| `create-cf-access-app.sh` | Creates an Access app + policy |
| `wait-for-vm-ready.sh` | Polls Proxmox guest agent until guest reports healthy |
| `customer-health-check.sh` | The post-provision sanity test |

These are kept as sub-scripts (not inline) so they can be re-run individually for debugging.

## 3.4 Tier-specific behaviour

Three tiers, three slightly different shapes:

| Tier | VM | Coolify | Supabase | Cost | Use case |
|---|---|---|---|---|---|
| `site` | Shared (same VM as other site-tier customers, isolated by Coolify team) | Yes | No | £35/mo | Brochure sites |
| `site-db` | Dedicated | Yes | Yes (smallest preset — 2 GB RAM cap) | £99/mo | Sites with a backend |
| `pro` | Dedicated | Yes | Yes (full preset — 8 GB RAM) | £249/mo | Production apps |

The orchestrator's tier branch:

```bash
case "$TIER" in
  site)
    # Don't clone a new VM. Add a team workspace to the shared site VM.
    SHARED_VMID=$(get_or_create_shared_site_vm)
    create_coolify_team "$SLUG" "$SHARED_VMID"
    ;;
  site-db | pro)
    # Full clone path
    clone_vm
    push_customer_env
    ...
    ;;
esac
```

Pro vs site-db differs only in:
- VM resources (`qm set --memory ...`, `--cores ...`)
- Default Supabase preset (`SUPABASE_PRESET=small|full` in customer.env)
- Backup frequency (site-db: daily, pro: 2x daily — phase 4 setting)

## 3.5 Deprovisioning: `deprovision-customer.sh`

Mirror of provision-customer. Lives at `scripts/deprovision-customer.sh`.

```
confirm
  └─ read --slug, then prompt: "Type the slug again to confirm: "

snapshot-final
  ├─ ssh customer VM, run pg_dump to /tmp/final-dump.sql.gz
  ├─ rclone copy to b2:wcn-cloud-backups/<slug>/final/
  └─ keep for 30 days minimum (B2 lifecycle)

remove-cf
  ├─ DELETE /access/apps/{coolify_app_id}
  ├─ DELETE /access/apps/{supabase_app_id}
  ├─ DELETE /custom_hostnames/{id} for any custom domains
  ├─ DELETE /dns_records/{id} for slug.app CNAME
  └─ DELETE /cfd_tunnel/{id}

remove-vm
  ├─ qm stop <vmid> (timeout 60s, then qm stop --skiplock)
  ├─ qm destroy <vmid> --purge --destroy-unreferenced-disks 1

mark-deleted
  ├─ UPDATE customers SET status='deleted', deleted_at=now()
  ├─ UPDATE vms SET status='destroyed'
  ├─ INSERT audit_log

print-summary
  ├─ what was removed
  └─ where the final dump lives
```

We never DELETE customer rows — only soft-delete with a status. The audit log is permanent.

## 3.6 Running the orchestrator

From your workstation (assumes ssh-agent has the right key loaded, env vars set):

```bash
export CF_API_TOKEN=...
export CF_ACCOUNT_ID=...
export CF_ZONE_ID=...
export PROXMOX_API_TOKEN=...
export OPS_DB_URL=...

cd "C:/Users/LeoWilson/server project/IaaS"

./scripts/provision-customer.sh \
  --slug acme \
  --tier pro \
  --domain acme.com \
  --email admin@acme.com \
  --name "Acme Ltd" \
  --brand-colour "#ff5500"
```

Expected output (~10 min for tier=pro, with full clone):

```
[1/10] Validating arguments... ok
[2/10] Allocating VMID 201, IP 10.10.31.10... ok
[3/10] Creating Cloudflare Tunnel wcn-cloud-acme... ok (id: abc123...)
[4/10] Creating DNS record acme.western-communication.com... ok
[5/10] Cloning Proxmox VM 9001 → 201 (this takes ~3 min)... ok
[6/10] Configuring VM (cloud-init: IP, SSH key)... ok
[7/10] Booting VM... ok (ready in 47s)
[8/10] Pushing customer.env + tunnel cert, running firstboot... ok (3m 14s)
[9/10] Creating Cloudflare Access apps + policies... ok
[10/10] Health check... ok

✅ Customer 'acme' provisioned successfully.

   Console:   https://acme.western-communication.com/coolify
   Supabase:  https://acme.western-communication.com/supabase
   Admin:     admin@acme.com (must sign in via SSO)

Next steps:
  • Send the welcome email (template: runbooks/new-customer.md)
  • When customer's ready, run: ./scripts/add-custom-domain.sh --slug acme --domain acme.com
```

## 3.7 Test it on a fake customer

Before going to phase 4 (real pilot), run the orchestrator end-to-end with `--slug test-001` and confirm everything works.

```bash
./scripts/provision-customer.sh \
  --slug test-001 --tier pro --domain test001.example.com \
  --email leo.wilson@westerncommunication.co.uk \
  --name "Test Customer 001"
```

Then deprovision:

```bash
./scripts/deprovision-customer.sh --slug test-001
```

Confirm:
- VM 201 is gone (`qm list | grep 201` → empty)
- DNS record gone (`dig test-001.western-communication.com` → NXDOMAIN)
- CF tunnel gone (CF dashboard → Zero Trust → Networks → Tunnels)
- ops DB row marked deleted (`psql … -c "select slug, status from customers where slug='test-001'"`)
- B2 still has the final dump (`rclone ls b2:wcn-cloud-backups/test-001/final/`)

## 3.8 Acceptance

Phase 3 is done when **all four** are true:

1. `provision-customer.sh test-001` succeeds in ≤ 30 min total
2. The provisioned customer's `https://test-001.western-communication.com/coolify` is reachable (after Access SSO)
3. `deprovision-customer.sh test-001` cleanly removes everything except the final B2 dump
4. The ops DB shows the customer with `status='deleted'`, audit log has a row for both create + delete

## 3.9 Rollback

If a provision goes wrong mid-way:

```bash
./scripts/deprovision-customer.sh --slug <slug-being-provisioned> --force
```

`--force` skips the typed confirmation. It's safe because the deprov script is also idempotent — it'll only delete things that exist.

If the orchestrator script itself has a bug, you can manually unwind by:
- Looking at the audit log entries for the failed slug to see what was created
- Cleaning each up in CF dashboard / Proxmox / DNS / ops DB
- Or just nuking via `deprovision-customer.sh --slug ... --force`

---

**Next:** `phases/04-pilot.md`
