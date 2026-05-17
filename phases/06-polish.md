# Phase 6 — Polish

**Goal:** the platform is production-ready for sustained customer growth (10–25 customers) — automation is solid, ops are predictable, customers can self-serve nearly everything.

**Estimated time:** 4 weeks across multiple workstreams; mostly low-risk improvements.

**Prerequisites:** phase 5 acceptance.

---

## 6.1 Rolling updates

Right now, updating Coolify or Caddy in the template means manually re-running setup-template.sh, snapshotting v2, and somehow rolling forward existing customer VMs. Make that one command.

Build `scripts/rolling-update.sh`:

```
parse-args
  ├─ --component (coolify | caddy | cloudflared | all)
  ├─ --batch-size N (default 1, max 5)
  ├─ --dry-run (default false)
  └─ --skip-customers slug,slug   (exclude specific customers, e.g. mid-deploy)

discover
  └─ SELECT slug, ip FROM vms WHERE status='active'
       (ordered: smallest-tier first, last-touched-longest-ago next)

per-batch
  for each batch of N:
    for each customer in batch:
      ├─ (1) snapshot the VM (Proxmox snapshot) for fast rollback
      ├─ (2) ssh into the VM
      ├─ (3) run /opt/wcn-cloud/bin/upgrade-<component>.sh
      ├─ (4) wait for service healthy (curl loops)
      ├─ (5) run customer-health-check.sh
      ├─ (6) on failure: rollback to snapshot, stop the run, alert
      └─ (7) on success: delete snapshot (saves disk), continue
    await all of batch before next batch
```

Ops procedure: tested first on test-001, then a single low-tier customer, then the rest. Always between business hours of the customer's region (or coordinated maintenance window).

## 6.2 Customer self-service of common ops

Pages to add to the console:

- `/projects/:id/restart` — restart the app container
- `/projects/:id/scale` — change replicas / size (within tier limit)
- `/databases/:id/run-sql` — read-only SQL console (with rate limit)
- `/team/invite` — they invite their own users (with role: admin / developer / viewer)
- `/billing/upgrade` — let them go up a tier (down-tier requires us — too easy to lose data)
- `/support` — opens a Linear issue in our tracker via a webhook

Each of these is a page in the console + a backend job. The actual work is still scripted; the console is just a friendly button.

## 6.3 Status page integration

The status page must survive a DC outage, so it cannot live on Dreadnaught. Pick one:

**Option A — Cloudflare Pages (static, recommended).** Internal monitor VM polls Uptime Kuma's API every minute, regenerates a static HTML page, pushes to a CF Pages project via the CF API. Free, survives DC outage, fully under our control.

**Option B — External SaaS** (BetterStack, Atlassian Statuspage, Instatus). £0–£20/mo. Less work, less flexible.

Wire whichever you pick into:
- Uptime Kuma webhook (auto-degrade a component when a monitor goes red)
- Cloudflare Health Check notifications (alert + auto-update the public status)
- Our internal `incident.sh` script (for declared incidents)
- The console's `/support` page (link to the status page)

Build `scripts/incident.sh`:

```
incident.sh declare \
  --title "VM 201 unreachable" \
  --severity major \
  --component "Proxmox host" \
  --components "customer-acme,customer-foo"

# posts to Slack via webhook, updates the status page (CF Pages rebuild or SaaS API).
```

```
incident.sh resolve <incident-id>

# closes the incident, posts the resolution, marks components green.
```

## 6.4 Observability of the platform itself

Add platform-level monitors:

| What to watch | How | Where to alert |
|---|---|---|
| Each customer VM's CPU/RAM | Telegraf (or node_exporter) on each VM → wcn-monitor VM at 10.10.30.20 | Slack if sustained > 80% for 10 min |
| Each customer VM's disk | Same | Slack if > 85% |
| Coolify health endpoint | Telegraf hits localhost:8000/api/v1/health every 60s | Slack if down 3 cycles |
| cloudflared tunnel health | Cloudflare API: GET /accounts/.../cfd_tunnel/{id}/connections | Slack if 0 healthy connections for 2 min |
| Backup job success | The backup script writes "OK <slug> <ts>" to a status file; cron sends to Slack if any slug missing | Slack |
| Postgres replication lag (when we have it) | Phase 7 only | Slack |

Telegraf config lives at `IaaS/configs/telegraf.conf` and is added to the template VM when we build a v2.

## 6.5 Hardening

These are the items from `dc-deployment/whitelabel-and-automation.md` § "Hardening to-do" and the per-VM security checklist.

| Item | Why | Effort |
|---|---|---|
| `fail2ban` on each VM | SSH brute-force protection | 5 min, in template |
| Auto-rotate cloudflared tunnel cred every 90 days | Limit blast radius of a leak | 30 min one-off + script |
| `apparmor` profiles for Docker on each VM | Container escape limit | 1 day to tune |
| Linux audit (`auditd`) → forwarded to ops VM | Forensics if something happens | 4 hr |
| Rotate Proxmox API token quarterly | Same | 30 min, calendar reminder |
| Rotate B2 keys quarterly | Same | 30 min, calendar reminder |
| Customer-VM SSH disabled by default; enable only for ops-debug via short-lived CF Access for SSH | Customers can't exfil via SSH | 1 day |
| Per-customer VM has `iptables OUTPUT` rules limiting destinations | Defence in depth — a compromised VM can't pivot widely | 1 day to design + deploy |

Don't do all of these at once. Pick the highest-risk ones (SSH allow-list, audit, AppArmor) for the post-pilot push.

## 6.6 Documentation pass

The docs in this folder were written ahead of the implementation. After phase 5, walk every doc and update with what *actually* happened:

- `00-prerequisites.md` — any dependency we forgot
- `01-foundations.md` — actual times, actual issues
- `02-template-vm.md` — does the build script work first try? what was missing?
- `03-provisioning.md` — does the orchestrator work end-to-end? edge cases?
- `04-pilot.md` — what we learned from the pilot
- `ARCHITECTURE.md` — is the diagram still accurate?

Any new pattern discovered should also become a runbook.

## 6.7 SLA + DPA

By phase 6, you have a real product with paying customers. Get the legal layer in place:

1. **SLA**: written, signed at customer onboarding. 99.9% target on Pro tier (43m/mo allowed downtime). Service credits if we miss.
2. **DPA**: GDPR data processing addendum, with sub-processor list (Cloudflare, plus your backup-target provider, plus any external status-page SaaS if used). Standard template that legal can tailor.
3. **Acceptable use policy**: what they can/can't host (no spam, no abuse, no unlawful content, no crypto mining without prior agreement).
4. **Backup retention policy**: written. Currently: 7 daily + 4 weekly + 12 monthly + 7 annual.
5. **Restoration RTO/RPO commitment**: RTO 4h, RPO 24h on Pro tier. 8h/24h on Site+DB. None on Site.

Get a paid hour of legal review on each. ~£1k well spent.

## 6.8 Customer migration off (exit plan)

A real signal of trust: we tell customers up-front how to leave. Add to the docs:

> If you ever want to leave, we'll provide:
> - A pg_dump of all your databases
> - A tar.gz of your app config + env vars
> - 30 days of overlap during which both old and new hosts can be live (DNS-controlled)
> - A migration call (1 hour, no charge)
>
> No exit fees, no data ransom, no "you can only export to specific platforms".

This is a marketing asset as much as a contract clause.

## 6.9 Acceptance

Phase 6 is done when **all six** are true:

1. `rolling-update.sh` has been run on the live customer fleet at least once with no incidents
2. The console exposes self-service for the 6 ops in § 6.2
3. Status page auto-updates on monitor red
4. Telegraf metrics flowing for every customer VM
5. SLA + DPA are signed for every paying customer
6. The docs match reality

## 6.10 Rollback

Each polish item is independent. Roll back individually if issues arise. Most are additive (telegraf, status page integration, etc.) — to roll back, just stop the new component.

The risky one is `rolling-update.sh`. Before merging that script:
- Test on a throwaway VM 10× consecutively
- Test rollback (kill mid-run, ensure the VM snapshot restore works)
- Document the rollback explicitly

---

**Next:** `phases/07-scale.md`
