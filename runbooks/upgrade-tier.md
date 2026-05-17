# Runbook: upgrade or downgrade a customer's tier

**Use when:** customer asks to move between Site / Site+DB / Pro tiers.

**Owner:** ops + accounts (joint).

**Time:** 15 min for upgrade, 1 hr for downgrade (downgrades require migration).

---

## Upgrades (Site → Site+DB → Pro)

Always safe — we're only adding capacity / features.

### Site → Site+DB

The customer's app moves from a shared VM to a dedicated one. ~30 min downtime.

1. Provision a new dedicated VM:

   ```bash
   ./scripts/provision-customer.sh \
     --slug acme-tmp \
     --tier site-db \
     --domain acme.com \
     --email admin@acme.com \
     --name "Acme Ltd"
   ```

2. Migrate their app config from the shared site VM:
   - SSH to the shared VM
   - Export their Coolify project config (their team's)
   - Import on the new dedicated VM (Coolify supports import via UI)

3. Set up DB if they didn't have one before — fresh Supabase instance on the new VM.

4. Cutover:
   - Update DNS for `<slug>.app.western-communication.com` (CNAME → new tunnel)
   - Reissue Access apps against the new VM's tunnel
   - Update ops DB

5. Once verified, remove their team from the old shared VM.

6. Update billing in CRM.

### Site+DB → Pro

Same VM, more resources (RAM/CPU) + DB tier bump.

```bash
ssh root@192.168.50.50
qm set <vmid> --memory 8192 --cores 6
qm reboot <vmid>     # or: qm set with hotplug if memory hotplug works on this kernel
```

Update Supabase preset too (RAM cap on Postgres):

```bash
ssh ops@<ip>
sudo nano /etc/wcn-cloud/customer.env
# change SUPABASE_PRESET=small to SUPABASE_PRESET=full
sudo systemctl restart wcn-firstboot.service     # idempotent — applies the change
```

Update ops DB:

```sql
UPDATE customers SET tier='pro' WHERE slug='acme';
```

Confirm with the customer once the resize completes.

---

## Downgrades (Pro → Site+DB → Site)

Riskier — we're **reducing** capacity. May not fit. Always do a sanity check first.

### Pre-flight

- Are they using the resources they're paying for? Check Telegraf:
  - Pro → Site+DB: peak RAM > 3 GB? Cores > 4? If yes, will be hard to fit.
  - Site+DB → Site: do they have a database? If yes, can't downgrade — they'd lose it.
- Are they OK with the data loss / restrictions of the lower tier?

### Pro → Site+DB

Same VM, lower resources.

```bash
ssh root@192.168.50.50
qm shutdown <vmid> --timeout 60      # graceful
qm set <vmid> --memory 4096 --cores 4
qm start <vmid>
```

Update Supabase preset:

```bash
ssh ops@<ip>
sudo nano /etc/wcn-cloud/customer.env
# SUPABASE_PRESET=full → small
sudo systemctl restart wcn-firstboot.service
```

If Postgres uses too much RAM at the new preset, customer will need to either:
- Upgrade back to Pro
- Migrate some data out / archive

### Site+DB → Site

Customer **loses the database**. Confirm in writing they're OK with this.

1. Take a final pg_dump and email it to them:

   ```bash
   ssh ops@<ip> 'docker exec $(docker ps -q -f name=supabase-db) pg_dumpall -U postgres' > /tmp/<slug>-final.sql
   gzip /tmp/<slug>-final.sql
   # email the .sql.gz to the customer (or upload to a secure transfer)
   ```

2. Provision a new Site (shared) tier VM:

   ```bash
   ./scripts/provision-customer.sh --slug <slug>-tmp --tier site ...
   ```

3. Migrate their app config (via Coolify export/import).

4. Cutover DNS + Access apps.

5. Deprovision the old VM:

   ```bash
   ./scripts/deprovision-customer.sh --slug <slug>
   ```

6. Rename the new tenant in ops DB:

   ```sql
   UPDATE customers SET slug='<slug>' WHERE slug='<slug>-tmp';
   ```

   (Or just keep them on `<slug>-tmp` if simpler — depends on whether the old slug is appearing in their custom URLs.)

7. Update billing.

### Why downgrades are slower

Provisioning a new VM in the lower tier is the cleanest way to ensure we
don't carry over per-customer state from the higher tier. We could try to
"shrink in place" but every time we've tried that in similar systems, we
hit edge cases (orphaned containers, stale env vars, leftover backups).

---

## Billing-side

In CRM:
- Update tier
- Adjust next invoice (pro-rated for current period)
- If customer pre-paid annually: refund/credit the difference

For pre-pay annual customers downgrading: don't be petty. The credit applies to next year's renewal.
