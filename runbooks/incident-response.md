# Runbook: incident response

**Use when:** something is broken in production. Page came in, monitor went red, customer reported, etc.

**Owner:** whoever is on shift. Escalate to senior ops if Sev1.

---

## Severity definitions

| Sev | Definition | Response time |
|---|---|---|
| **Sev1** | Multiple customers down, or any customer's data is at risk | < 15 min |
| **Sev2** | One customer down, or major feature broken for everyone | < 1 hr |
| **Sev3** | Degraded performance, or workaround exists | < 4 hr |
| **Sev4** | Cosmetic, low-impact bug | next business day |

## Standard flow

```
detect → declare → diagnose → mitigate → resolve → postmortem
```

## 1. Declare (≤ 5 min)

```bash
./scripts/incident.sh declare \
  --title "<short title>" \
  --severity major \
  --message "<one-liner explaining the impact for customers>"
```

This:
- Posts to Cachet status page (`status.western-communication.com`)
- Posts to Slack #wcn-cloud-ops with `@here`
- Auto-emails subscribed customers (Cachet)
- Creates a Linear ticket in the ops project

If Sev1: **also page the senior ops via PagerDuty** (manual: send a `[SEV1]` Slack DM to senior ops on shift).

## 2. Diagnose (≤ 15 min for Sev1, ≤ 1 hr for Sev2)

Check, in order:

1. **Uptime Kuma** — what's red? Pattern (one customer? all? specific service?)
2. **Telegraf dashboard** — CPU/disk/network spikes anywhere?
3. **Cloudflared health** — `cf_api GET /accounts/.../cfd_tunnel/{id}` for affected slugs
4. **Proxmox host** — disk full? Out of memory? `ssh root@192.168.50.50; pvesh get /nodes/dreadnaught/status`
5. **MikroTik** — `/log print` for routing flaps. (Don't change config in incident mode.)
6. **Cloudflare upstream** — check `cloudflarestatus.com` (this also affects our Health Checks + Access)
7. **Backup target upstream** — check the status of whatever the RAID-image backup target is

Common patterns:

| Symptom | Likely cause | Quick check |
|---|---|---|
| All customers down | Proxmox host down OR Cloudflare incident | ssh dreadnaught; cloudflarestatus.com |
| One customer down | That VM crashed OR their tunnel disconnected | qm status N; cloudflared status |
| All TLS broken on custom domains | Cloudflare for SaaS issue | CF dashboard → custom hostnames |
| Backups failing | rclone auth, B2 outage, or disk full on coolify VM | tail /var/log/wcn-cloud/backup.log |
| Console down | Our own coolify VM, or our own tunnel | ssh 10.10.30.10 |

## 3. Mitigate

Goal: get customers' service back **before** doing the full fix. Options ordered by reversibility:

- **Restart the affected service** (`systemctl restart cloudflared` etc.)
- **Restart the affected container** (`docker restart <id>`)
- **Restart the affected VM** (`qm reset <vmid>` — last 30s of in-flight requests lost)
- **Failover to a snapshot** (only if state corruption — e.g. Postgres won't start)
- **Reroute via different tunnel** (rare — only if a tunnel itself is broken at CF's end)

Document **everything you tried** in the incident channel as you go. Even
the things that didn't work — a future you investigating a similar incident
will thank you.

## 4. Resolve

Once service is restored:

```bash
./scripts/incident.sh resolve <incident-id> \
  --message "Resolved: <root cause + mitigation in one sentence>"
```

This:
- Updates Cachet to green
- Posts resolution to Slack
- Emails subscribers

## 5. Postmortem (within 5 business days for Sev1/2)

Template at `runbooks/postmortem-template.md`. Cover:

- **What happened** (timeline, in UTC)
- **Impact** (which customers, how long, what they couldn't do)
- **Root cause** (technical)
- **What worked** (what helped us recover quickly)
- **What didn't** (what slowed us down)
- **Action items** (with owners + dates — must be concrete)

Save as `dc-deployment/postmortems/<date>-<slug-of-title>.md`.

For Sev1: **share with affected customers**. For Sev2/3: keep internal unless asked.

## 6. Update runbooks

If the incident revealed a gap in our runbooks (missing diagnostic step, unclear procedure), update the relevant runbook *now*, while it's fresh.

If you used a one-off command to mitigate and it should be in a script, file a Linear ticket to script it.

---

## Sev1 communication template

For mass-customer-affecting incidents:

```
Subject: [WCN Cloud] Service incident — investigating

Hi,

We're currently investigating an issue affecting all WCN Cloud customers.
At <time UTC>, we observed <symptom>. Customer applications may be
unreachable while we investigate.

We'll update you within 30 minutes either way. Live updates at:
  https://status.western-communication.com

— WCN Cloud team
```

Then send hourly until resolved.

After resolve:

```
Subject: [WCN Cloud] Resolved — root cause and next steps

Hi,

The incident from <time UTC> is now resolved. Affected: <duration>.

Root cause: <one paragraph plain English>.

What we're doing about it: <one paragraph>.

A full postmortem will follow within 5 business days.

If your application is still showing issues, please reply.

— WCN Cloud team
```

The promptness, completeness, and honesty of this communication is the
single biggest factor in customers staying after an incident. Don't
over-promise; don't blame third parties without explaining what we're
doing about it.
