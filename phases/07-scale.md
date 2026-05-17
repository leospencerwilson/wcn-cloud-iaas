# Phase 7 — Scale

**Goal:** roadmap for what comes *after* the platform is humming with 10–25 customers. **Not committed work** — these are options to evaluate when business pressure demands them.

**Estimated time:** open-ended. Each item is months of focused work.

**Prerequisites:** phase 6 acceptance. Real customer demand for these capabilities. Not "wouldn't it be cool if".

---

## 7.1 When to pull each lever

The triggers below tell you when an item is worth starting. **Do not start before the trigger fires** — premature scale work is the most expensive way to lose money in this kind of business.

| Item | Trigger to start |
|---|---|
| Second physical host (HA) | First Pro customer asks for 99.99% in writing **AND** revenue ≥ £5k/mo |
| Multi-region (second DC) | A customer with a contract worth ≥ £25k/mo asks **AND** their use case requires it (e.g. EU/UK data sovereignty) |
| Kubernetes migration | Customer count > 50 **AND** ops time > 50% of FTE on routine VM management |
| Self-service signup | A waiting list of > 20 unconverted leads **AND** signups are bottlenecking sales |
| Stripe integration (auto-billing) | Manual invoicing > 4 hr/week of accounts time |
| Usage metering (egress, storage) | A single customer's usage exceeds £100/mo of marginal cost |
| Terraform/Pulumi rewrite of provisioning | More than one engineer doing simultaneous provisioning, and bash scripts are conflicting |
| Multi-engineer dev environment | More than one engineer working on the platform daily |

If none of these triggers have fired, none of these items should be in scope.

## 7.2 Second physical host (HA)

The single biggest gap in the v1 architecture. Right now: Dreadnaught fails → everything goes down.

### Approach (likely): Proxmox cluster + Ceph

1. Buy a second box (DL20 or similar, ideally identical hardware).
2. Rack it in a different rack in the DC (different power feed, different network switch).
3. Build a 3-node Proxmox cluster (with a quorum-only third node — could be a VPS or a small NUC at the office).
4. Add Ceph storage on the two beefy nodes.
5. Migrate customer VMs to Ceph.
6. Configure HA: each VM has `ha_state=started, group=primary`, fails over on host loss in < 60s.

Cost: ~£2k for the box, ~£20/mo for the quorum VPS.

Risks: Ceph is operationally complex. Don't do it without practising recovery from disk loss in a lab first.

### Cheap alternative: warm standby

Don't cluster. Instead:
1. Buy a second box.
2. Replicate Proxmox VMs nightly via `vzdump | restore` to the second box.
3. On primary failure, manually power on the standby and update DNS / cloudflared origin IPs.
4. RTO: 30 min. RPO: 24 h.

This is a fraction of the operational complexity. Recommended for a long time before going Ceph.

## 7.3 Multi-region

If a customer needs UK-only or EU-only data residency:

1. Spin up a second Proxmox host in a UK or EU DC (e.g. Equinix LD8 or Hetzner Falkenstein).
2. Replicate the template VM there.
3. Adapt `provision-customer.sh` to take `--region uk|eu|...`.
4. CF Tunnel + CF for SaaS work identically across regions.
5. Each region has its own ops DB shard or you keep one ops DB but tag rows with region.

Backups always go to the same B2 bucket (B2 has UK/EU regions) — pick the right region per customer's data.

## 7.4 Kubernetes (only if you really must)

The case for: when you have 50+ customers, each per-VM is wasting RAM. Containers in pods could run 5–10 customers per host.

The case against: Coolify isn't multi-tenant on Kubernetes. You'd be rebuilding it. Likely 9–18 months of focused work for one engineer.

If you go this way:
1. Pick a managed K8s control plane (don't run your own etcd) — Talos Linux + Sidero, or use Hetzner's managed K8s.
2. Build a customer-tenant abstraction: namespace per customer, NetworkPolicy isolation, resource quotas, separate Postgres per customer.
3. Replace per-customer cloudflared with a Cloudflare Tunnel per cluster, multiplexing customer traffic.
4. Migrate customers one by one, verify each.

Do not start until existing per-VM is causing real pain.

## 7.5 Self-service signup

What this requires:
1. Marketing site with a "Sign up" CTA
2. Sign-up flow (email, choose tier, choose slug, payment via Stripe)
3. Auto-provision (the orchestrator from phase 3 — already exists)
4. Auto-welcome email + onboarding video
5. Auto-fraud detection (Stripe Radar + IP reputation)
6. Auto-DPA (click-to-accept)
7. Customer support tier 1 — could be us, could be docs + chatbot

Don't underestimate the cost of moving from "human-in-the-loop" to "self-serve". The first 5 customers via self-serve will probably teach us things that break the orchestrator. Plan a 6-week stabilisation window.

## 7.6 Stripe integration

Two layers:

1. **Recurring billing**: Stripe Subscriptions, one per customer. Webhook → ops DB → console shows "next invoice on …"
2. **Usage-based**: Stripe Metered Billing, instrumented via the telegraf data from § 6.4. Daily cron pushes usage records.

Until 7.5, keep manual invoicing. It's £20/customer/year of accountancy time, vs. months of dev for self-service billing.

## 7.7 Usage metering

Once we have customers near tier limits, decide whether to enforce hard caps or charge for overage.

| Resource | How to measure | Decision needed |
|---|---|---|
| Egress bandwidth | Cloudflare analytics API (per zone, per day) | Hard cap (kill traffic past quota) or auto-charge? |
| Storage | df on the customer VM | Hard cap |
| Database CPU | postgres pg_stat_statements | Soft alert, manual upgrade discussion |
| Build minutes | Coolify build logs | Soft alert |

Recommendation: hard caps for v1 (so we don't get a £10k surprise from a runaway customer). Move to overage billing in phase 6+ after telegraf is reliable.

## 7.8 Terraform / Pulumi for provisioning

Worth doing when:
- More than one engineer is provisioning concurrently (state file is the source of truth)
- We start managing Cloudflare Access policies, DNS, custom hostnames, tunnels via code (drift detection)
- We need provisioning to be reviewed via PR before applying

Until then: bash + idempotent calls is faster.

If we do migrate, the cleanest path is:
1. Wrap each existing bash script in a Terraform resource (using `null_resource` + `local-exec`)
2. Slowly replace each with native Terraform providers (`cloudflare`, `proxmox`)
3. State file in S3 (B2 with the S3 API)

## 7.9 Bigger ideas (5+ years out)

These don't have a phase yet — they're on the horizon:

- **WCN as a Cloudflare Workers competitor for our customers** — let them deploy edge workers via our console. Backed by Cloudflare's actual Workers infra, but white-labelled.
- **WCN AI Suite** — managed LLM gateway, Cloudflare AI / OpenAI / Anthropic billing wrapped with our SLA + support.
- **WCN Marketplace** — pre-built apps customers can deploy with one click (CRMs, CMSes, the WCN-built suite).
- **Acquire a smaller hosting business** — instant book of customers if the platform is ready.
- **Sell the platform** — to another regional ISP / MSP that has customers but not the engineering depth to build this.

Each is months of strategic discussion, not engineering.

## 7.10 What this phase explicitly is *not*

- A commitment.
- A backlog.
- A list of things we'll do "if we have time".

It's a **decision register** — when triggered, here's the path; if not triggered, leave it.

---

**Next:** there is no next phase. By here, the platform is mature, you have a real business, and the next moves are commercial, not engineering.

(Maintenance still happens — keep `runbooks/` and `tests/` current.)
