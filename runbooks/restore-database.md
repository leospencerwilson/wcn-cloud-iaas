# Runbook: restore a customer's database from backup

**Use when:**
- Customer asks to roll back a destructive change ("we deleted our products table by accident")
- Disaster recovery scenario (DC outage, Postgres corruption)
- Periodic restore drill (do this monthly to ensure backups work)

**Owner:** senior ops only — this is destructive.

**Time:** 5 min for small DBs, up to 1 hr for big ones.

---

## 1. Decide what you're restoring

```bash
# List all backups for this customer
rclone ls b2:wcn-cloud-backups/acme/postgres/ | sort
```

Output looks like:

```
   142359 customer-acme-20260507T030001Z.sql.gz
   148011 customer-acme-20260506T030002Z.sql.gz
...
```

Confirm with the customer **which timestamp** they want restored. Read it back to them.

## 2. Confirm the destruction

A restore **drops** every existing database on the customer VM and replaces it with what's in the backup. Anything that's happened since the backup is gone.

Ask the customer in writing:

> To confirm: we will restore the backup from `<timestamp>`. Everything that's happened in your databases since then will be lost. Reply YES to confirm.

Wait for the YES. Don't assume.

## 3. Stop the customer's apps (so they don't keep writing)

```bash
ssh ops@<vm-ip> 'docker stop $(docker ps -q --filter "label=coolify.managed" --filter "label!=coolify.type=database")'
```

Or pause them via Coolify UI.

## 4. Run the restore

```bash
./scripts/restore-customer.sh \
  --slug acme \
  --backup 20260507T030001Z
```

The script will:
1. Download the backup from B2
2. SCP to the customer VM
3. Drop all DBs and replay the dump
4. Restart any stopped containers
5. Audit log the action

It'll prompt you to type the slug to confirm. Type `acme`.

## 5. Verify

- Customer VM is reachable: `curl -fI https://acme.western-communication.com/healthz`
- Their app starts cleanly: `ssh ops@<ip> 'docker ps'` shows the apps as `Up`
- A test query against Postgres returns expected data:
  ```bash
  ssh ops@<ip> 'docker exec $(docker ps -q -f name=supabase-db) psql -U postgres -c "SELECT count(*) FROM public.users;"'
  ```
  Confirm with the customer that the count matches what they expect.

## 6. Notify the customer

```
Hi <name>,

Restore complete. Your databases are now at the state of <timestamp UTC>.

We rolled back: every change between <timestamp> and now is gone.

Please verify your application is working as expected and let us know
if anything looks wrong. We've kept the post-restore state in case we
need to roll forward — for the next 24 hours.
```

## 7. Drop a note in ops Slack

```
Restored acme to backup 20260507T030001Z. Customer notified.
```

---

## Periodic restore drill

Once a month, pick a non-pilot customer (or a test customer) and run the
restore on a clone of their VM (don't actually restore prod). Confirm:
- Backup downloads
- DB ingests
- App starts
- Check ops audit log

Document the result in `runbooks/drill-log.md`.
