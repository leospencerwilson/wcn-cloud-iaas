# Runbook: roll out a Coolify / Caddy / cloudflared update across the fleet

**Use when:**
- A new version of Coolify (or Caddy, or cloudflared) needs to land on every customer VM
- Security patch with a CVE on the customers' running stack
- Periodic "every 4 weeks" hygiene update

**Owner:** ops on shift.

**Time:** N × ~5 min per VM (sequential), or N/batch_size × 5 min (parallel).

---

## 0. Pre-flight (15 min)

Before touching any customer VM, **try the upgrade on a test VM**:

```bash
# Provision a throwaway customer
./scripts/provision-customer.sh --slug rolling-test --tier pro \
  --domain rollingtest.example.com --email leo.wilson@westerncommunication.co.uk \
  --name "Rolling Test"

# Apply the upgrade just to it
./scripts/rolling-update.sh --component coolify --skip-customers \
  $(psql "$OPS_DB_URL" -At -c "SELECT string_agg(slug, ',') FROM customers WHERE status='active' AND slug != 'rolling-test'")

# Verify
./scripts/customer-health-check.sh rolling-test

# Cleanup
./scripts/deprovision-customer.sh --slug rolling-test --force
```

If anything looks wrong, **stop and fix the upgrade script** before touching real customers.

## 1. Announce on the status page (5 min)

```bash
./scripts/incident.sh declare \
  --title "Scheduled maintenance: Coolify rollout" \
  --severity scheduled \
  --message "We're rolling out a Coolify update across the fleet. Each customer's VM will briefly (~30s) restart Coolify. Apps will not be affected."
```

## 2. Pick a maintenance window

Avoid:
- 09:00–17:00 UK time on weekdays (when customers are using their apps)
- Customer-specific business hours if they're outside UK

Default: Tuesday 03:00 UTC. (Don't roll on Friday — too late if it goes wrong.)

## 3. Run the rolling update

```bash
./scripts/rolling-update.sh --component coolify --batch-size 1
```

`--batch-size 1` is recommended for the first time. Once we've done this 3+ times without issue, can move to `--batch-size 3`.

The script:
1. Iterates VMs in least-recently-touched order
2. For each: snapshot → upgrade → health-check → drop snapshot
3. On failure: rolls back to snapshot, **stops the run**, alerts you

## 4. Monitor

Watch the script output. Also watch:
- Uptime Kuma — a monitor going red mid-run is a signal
- Slack #wcn-cloud-ops — customer complaints often arrive there first

If a customer messages mid-run: pause the run with Ctrl-C (it'll cleanly stop after the current VM), investigate, decide whether to continue.

## 5. Resolve the maintenance

```bash
./scripts/incident.sh resolve <incident-id>
```

## 6. Verify the fleet

After the run, sanity-check a sample of customer VMs:

```bash
for slug in $(psql "$OPS_DB_URL" -At -c "SELECT slug FROM customers WHERE status='active' ORDER BY random() LIMIT 5"); do
  ./scripts/customer-health-check.sh "$slug"
done
```

## 7. Document

Append to `runbooks/rolling-update-log.md`:

```
## 2026-05-12 — Coolify v4.X.Y
- Fleet size: 12
- Batch size: 1
- Duration: 1h 4m
- Rollbacks: 0
- Notes: smooth, no issues
```

---

## Troubleshooting

**Upgrade fails on one customer mid-run**

Script auto-rolls back that customer to snapshot and halts. Investigate that
specific VM (`ssh ops@<ip>`, look at journals). Once fixed, resume:

```bash
./scripts/rolling-update.sh --component coolify --skip-customers <successful-customers-csv>
```

**Snapshot succeeds but rollback fails**

This shouldn't happen — Proxmox snapshots are reliable. If it does:
1. SSH to the Proxmox host
2. `qm rollback <vmid> <snap-name>` manually
3. `qm start <vmid>`
4. Drop the snapshot manually
5. Open a P2 ticket for ops to investigate why automation didn't work

**Health check passes but customer reports issues hours later**

Possible: a slow-starting service (e.g. a worker container) didn't immediately
fail health-check but is now failing. Look at telegraf metrics + Coolify logs.
This is why we keep the snapshot for 24h — but the script auto-deletes it on
success. Trade-off: keep snapshots for a configurable window? See backlog.
