# Architecture

How WCN Cloud fits together, end to end.

## High-level

```
                          ┌───────────────────────────────────────┐
                          │ Customer's browser                    │
                          │ (their employees / their app users)   │
                          └─────────────────┬─────────────────────┘
                                            │
                                            ▼
                          ┌───────────────────────────────────────┐
                          │ Cloudflare edge                       │
                          │  • DDoS, WAF                          │
                          │  • Universal SSL + Advanced Cert      │
                          │  • Cloudflare for SaaS (custom doms.) │
                          │  • Cloudflare Access (Entra ID IdP)   │
                          └─────────────────┬─────────────────────┘
                                            │
                                            ▼ (Cloudflare Tunnel — outbound from origin)
                ┌───────────────────────────┴───────────────────────────┐
                │                                                       │
                ▼                                                       ▼
┌───────────────────────────────┐                       ┌──────────────────────────────┐
│ console.western-communication │                       │ Per-customer Cloudflare       │
│  (our Next.js console UI)     │                       │ Tunnel — one per VM           │
│  Hosted on our own Coolify    │                       │ (HTTPS terminates at CF;      │
│                               │                       │  origin sees plain HTTP)      │
└───────────┬───────────────────┘                       └──────────┬───────────────────┘
            │                                                      │
            │ talks to per-customer Coolify API                    │
            │ via signed token                                     │
            └────────────┬─────────────────────────────────────────┘
                         │
                         ▼
        ┌─────────────────────────────────────────────────┐
        │ Proxmox VE 9 host: dreadnaught                  │
        │  192.168.50.50 (mgmt VLAN 10)                   │
        │                                                  │
        │   ┌──────────────────────────────────────────┐  │
        │   │ Coolify VM (10.10.30.10) — VLAN 30 DMZ  │  │
        │   │  • Our own Coolify + Supabase (Studio    │  │
        │   │    behind Access)                        │  │
        │   │  • The console UI (this folder's app)    │  │
        │   │  • The ops Postgres (wcn_cloud_ops DB)   │  │
        │   │  • Cron jobs: backup orchestrator        │  │
        │   └──────────────────────────────────────────┘  │
        │                                                  │
        │   ┌──────────────────────────────────────────┐  │
        │   │ Customer VMs (VLAN 31, 10.10.31.0/24)    │  │
        │   │  ┌────────┐ ┌────────┐ ┌────────┐ ...   │  │
        │   │  │ cust1  │ │ cust2  │ │ cust3  │       │  │
        │   │  │  .10   │ │  .11   │ │  .12   │       │  │
        │   │  │ Coolify│ │ Coolify│ │ Coolify│       │  │
        │   │  │ Caddy  │ │ Caddy  │ │ Caddy  │       │  │
        │   │  │ Tunnel │ │ Tunnel │ │ Tunnel │       │  │
        │   │  │+Supabase  +their app  +Supabase      │  │
        │   │  └────────┘ └────────┘ └────────┘       │  │
        │   └──────────────────────────────────────────┘  │
        └─────────────────────────────────────────────────┘
                         │
                         ▼ outbound only
        ┌────────────────────────────────────────────────┐
        │ External services                              │
        │  • Backblaze B2 (offsite Postgres backups)     │
        │  • Cloudflare Health Checks (external liveness)│
        │  • GitHub/GitLab/Bitbucket (customer repos)    │
        └────────────────────────────────────────────────┘
```

## Tenancy

**One Proxmox VM per customer** (sites tier may share — see § "Shared-tenant exception").

Each VM contains:
- **Coolify** (PaaS engine — handles git deploys, env vars, logs, database management)
- **Caddy** (lock-down reverse proxy — sits in front of Coolify, allow-lists paths, injects white-label CSS)
- **cloudflared** (per-customer tunnel — provides public hostnames)
- **Their workloads** (their app + their Supabase stack, deployed by Coolify)
- **A `customer.env`** at `/etc/wcn-cloud/customer.env` describing slug, brand, etc.

A customer cannot:
- Reach another customer (firewall rule on MikroTik: `vlan31 → vlan31 drop`)
- Reach mgmt VLAN (`vlan31 → vlan10 drop`)
- Reach our DMZ (`vlan31 → vlan30 drop`)
- See another customer's data (different VM = different kernel, different filesystem)

A customer **can**:
- Reach the public internet (their app calls third-party APIs)
- Be reached on their public hostnames via their Cloudflare Tunnel

## Data flow on a customer request

1. End user (their visitor) hits `https://customer-domain.com`
2. DNS resolves to Cloudflare's anycast network
3. Cloudflare for SaaS validates the hostname is registered against our zone, terminates SSL
4. Cloudflare matches the hostname to the customer's tunnel via the tunnel's ingress rules
5. Tunnel connection (already established outbound) forwards request to `localhost:80` on the customer's VM
6. Caddy (in the VM) sees the request, matches the `Host:` header, routes to Traefik (Coolify's built-in proxy)
7. Traefik routes to the right container (their app, or Supabase Kong, etc.)
8. Container returns response → reverse path → end user

Latency: ~1 hop more than a direct origin (the Cloudflare anycast bit), worth ~10-20 ms vs the security/DDoS/free-SSL benefits.

## Auth flow on a console login

1. Customer admin hits `https://console.western-communication.com`
2. Cloudflare Access intercepts (no JWT cookie yet)
3. Redirects to `westerncommunication.cloudflareaccess.com/...` (our team domain)
4. Their browser logs in via Microsoft Entra ID (their `@theircompany.com` account, federated to our app via Entra app registration)
5. Cloudflare Access checks the policy: `Emails ending in westerncommunication.co.uk` (us) OR specific customer admin emails. If allowed, mints a JWT and redirects back.
6. Our Next.js console reads the JWT from the `Cf-Access-Jwt-Assertion` header
7. Backend looks up which customer this email belongs to in the ops DB
8. Returns the right scoped view

A customer admin is never an "ops user". They see only their own data. Defence in depth: even if our UI accidentally shows them another tenant's data, Coolify's per-VM tokens still scope what they can affect.

## Where each piece of code/config lives

| Thing | Where | Why |
|---|---|---|
| Coolify (per customer) | Customer's VM, port 8000 (Caddy proxies) | Keep the runtime co-located with the workloads it manages |
| Caddy (per customer) | Customer's VM, port 8080 | Lock-down between Coolify and the tunnel |
| cloudflared (per customer) | Customer's VM, systemd service | Each customer is portable to another physical host |
| Provisioning scripts | Workstation (Leo's PC for now; later moves to a runner VM) | Manual control over orchestration |
| Ops DB (our metadata) | Our Coolify VM (10.10.30.10), Postgres database `wcn_cloud_ops` | Single source of truth for who's who |
| Console UI (Next.js) | Our Coolify VM, deployed via our own Coolify | Eat our own dog food |
| Backups (offsite) | Backblaze B2 (`wcn-cloud-backups` bucket), per-customer prefix | Independent of our DC + Cloudflare |
| External liveness | Cloudflare Health Checks (account-level, free) | CF probes from its global network — independent of our DC, so it detects a DC outage |
| Internal dashboards | `wcn-monitor` VM on Proxmox (10.10.30.20), Uptime Kuma + Grafana + Prometheus | Ops trend data; reachable via CF Access only |
| Status page | Deferred to phase 6 — Cloudflare Pages (static) or external SaaS | Must survive a DC outage; not co-hosted with Dreadnaught |

## Shared-tenant exception

The "Site" tier (£35/mo, brochure sites only, no Postgres) optionally shares a single Coolify VM via Coolify's **team** feature, with each Site customer getting a team workspace rather than a whole VM.

This trade is explicit and only acceptable for sites that:
- Are not handling personal data
- Have no database
- Don't have any "we need a kernel boundary" requirement

Site+DB and Pro tiers always get their own VM. The provisioning script's `--tier site` path uses the shared route; `--tier site-db` and `--tier pro` always get a fresh VM clone.

## Decision log (for future engineers)

- **Why per-VM not per-namespace (Kubernetes)?** Coolify isn't designed for multi-tenant Kubernetes. We'd be rebuilding it. Per-VM gives the same boundary at 1/10th the engineering cost up to ~50 customers.
- **Why Coolify and not roll our own?** Coolify already does git deploys + Supabase template + dashboards. Replacing that = 6 months of engineering. Wrap, don't replace.
- **Why Cloudflare for SaaS for custom domains?** Customer adds *one* DNS record and it's done. Anything else (Let's Encrypt, ACME, etc.) requires more from the customer + more on our side.
- **Why a separate VLAN (31) for customers, not shared with our DMZ (30)?** Forces firewall rule explicit-ness. Our own services and customers' services should not share a broadcast domain — the moment they do, accidental cross-talk becomes possible.
- **Why Caddy not Nginx for the lock-down proxy?** Caddy's config is human-readable and has automatic reloads. Nginx is more config-fragile for the response-rewriting we need.
- **Why bash for v1 provisioning, not Terraform?** Terraform implies state files, providers, plan/apply cycles. For 10 customers and one operator, bash + idempotent calls is faster to write, faster to debug, easier to read. Terraform becomes worth it at ~50 customers or when more than one engineer is provisioning concurrently.

## What's intentionally not in scope (yet)

- Kubernetes
- Self-service signup
- Stripe integration
- Multi-region (single DC for now; Cloudflare's network provides external liveness alerting from outside the DC)
- 99.99% SLAs (need second physical host first)
- Customer-billable usage metering (egress, storage)
- Any feature beyond "deploy git, manage Supabase, custom domain"

These all live in `phases/07-scale.md` if/when justified.
