# Runbook: deprovision a customer

**Use when:** customer cancels, fails to pay, or asks to be removed (GDPR right-to-erasure).

**Owner:** senior ops + accounts (joint sign-off).

**Time:** 30 min.

---

## 1. Pre-flight checks (5 min)

- [ ] Cancellation reason recorded in CRM
- [ ] Final invoice sent and either paid or written off (accounts decision)
- [ ] If migrating away: customer has confirmed they have a `pg_dump` and `tar.gz` of their app config
- [ ] If GDPR erasure: legal has approved (we're allowed to keep the financial records audit even after erasure — just not the app data)
- [ ] **30-day notice has elapsed** (per our terms — unless they explicitly waived it)

## 2. Take a final backup (5 min)

The deprov script does this automatically, but as a belt-and-braces:

```bash
ssh ops@<vm-ip>
docker exec $(docker ps -q -f name=supabase-db) pg_dumpall -U postgres > /tmp/final.sql
gzip /tmp/final.sql
exit

scp ops@<vm-ip>:/tmp/final.sql.gz /tmp/
rclone copy /tmp/final.sql.gz b2:wcn-cloud-backups/<slug>/final-manual/
```

## 3. Send the customer a "we're about to delete" email (1 min)

```
Hi <name>,

This is the final notice before we deprovision your WCN Cloud account.

What we'll do: at <date+1d>, we will delete your virtual machine and
custom domain configurations. We will keep one final database backup
in cold storage for 30 days, after which it is permanently destroyed.

If you need anything from your account before then — even just a
last-minute pg_dump — reply to this email and we'll help.

— Leo / WCN
```

Wait the agreed window (24 hr is our minimum). Then:

## 4. Run the deprov script (15 min)

```bash
./scripts/deprovision-customer.sh --slug acme
```

The script:
1. Takes a final pg_dump → B2 (`<slug>/final/`)
2. Removes Cloudflare Access apps for this customer
3. Removes any custom hostnames
4. Deletes DNS record + tunnel
5. Stops + destroys the Proxmox VM
6. Marks customer + vms + domains rows as `deleted` in ops DB
7. Audit log entries

You'll be prompted to type the slug. Don't `--force` unless you're 100% sure.

## 5. Verify (5 min)

- [ ] `qm list | grep <vmid>` → empty
- [ ] `dig <slug>.western-communication.com` → NXDOMAIN
- [ ] `psql … -c "select status from customers where slug='<slug>'"` → `deleted`
- [ ] `rclone ls b2:wcn-cloud-backups/<slug>/final/` → ≥ 1 file

## 6. Confirm to the customer (1 min)

```
Hi <name>,

Your WCN Cloud account has been deprovisioned. Your final database
backup is in our cold storage for 30 days (until <date+30>) — let us
know before that if you'd like a copy.

We hope our paths cross again. If you'd be willing to share what
prompted the move, we'd be grateful for the feedback.

— Leo / WCN
```

## 7. Update internal records

- CRM → mark account as "Deprovisioned <date>"
- If GDPR erasure: tag the account with that flag (so we don't accidentally re-engage)
- Slack #wcn-cloud-ops: `deprovisioned <slug> @ <ts>`

## 8. Calendar reminder (1 min)

Set a reminder for `<date+30>` to permanently delete the final backup
from B2 (only if the customer was a non-GDPR-erasure case). If GDPR
erasure: this should be `<date+1>` — i.e. the next day.

Permanent delete:

```bash
rclone delete b2:wcn-cloud-backups/<slug>/
rclone purge b2:wcn-cloud-backups/<slug>/
```

Audit log:

```bash
psql "$OPS_DB_URL" -c "INSERT INTO audit_log (actor, action, slug, details) VALUES ('$USER', 'final-purge', '<slug>', 'B2 prefix deleted')"
```

---

**Done.** Their account is gone, their data is gone, the audit trail remains.
