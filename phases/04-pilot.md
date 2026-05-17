# Phase 4 — Pilot customer

**Goal:** one real WCN customer is fully migrated to WCN Cloud, paying, happy, and acting as our reference customer.

**Estimated time:** 2 weeks (mostly customer-driven calendar).

**Prerequisites:** phase 3 acceptance complete.

---

## 4.1 Picking the pilot

Selection criteria — choose someone who is:

1. **An existing WCN customer** — they trust us, we have a relationship.
2. **Technical enough to give useful feedback** — at least one person on their side who knows what a database is.
3. **Tolerant of issues** — they understand "pilot" means "things will sometimes break, we will respond fast".
4. **Not mission-critical 24/7** — if their hosting goes down for an hour, no patient dies. Avoid healthcare-direct services for v1.
5. **A good fit for the Pro tier** — they have a real app + DB, not just a brochure site, so we exercise the full stack.

Document the chosen customer here once selected:

| Field | Value |
|---|---|
| Customer name | _TBD_ |
| Customer admin | _TBD_ |
| Customer admin email | _TBD_ |
| Their primary domain | _TBD_ |
| Slug | _TBD_ |
| Tier | _TBD_ (probably `pro`) |
| Stack we're hosting | (Next.js + Postgres? Their existing PHP site? other?) |
| Migration source | (where their data lives now) |

## 4.2 Pre-pilot meeting

Schedule 60 min with the customer admin. Cover:

1. **What WCN Cloud gives them** — read from `dc-deployment/managed-hosting-offering.md` § "What you get"
2. **What changes** — specifically: they get a console, can self-deploy git, can manage env vars, can manage DB.
3. **What stays the same** — billing relationship with us, single point of contact (us), SLA in writing
4. **The pilot deal**: 3 months at 50% off, in exchange for a written reference + screenshot in our case studies (only if they're happy at the end).
5. **Migration plan**: what they migrate from, when, how (we run a migration call, do it together).
6. **Cutover date**: usually 2 weeks out.
7. **What we need from them**:
   - Access to their existing host (read-only is fine — we don't push)
   - DNS control for their domain (or willingness to update CNAMEs)
   - One person responsive during the cutover window

Output: a signed (or email-confirmed) migration plan with the date.

## 4.3 Provision their VM

Day before the cutover (or earlier — VMs are cheap, idle is fine):

```bash
./scripts/provision-customer.sh \
  --slug <slug> \
  --tier pro \
  --domain <their-domain> \
  --email <their-admin-email> \
  --name "<Customer Ltd>"
```

Verify (per phase 3 § 3.8 acceptance) the VM is healthy.

## 4.4 Deploy their app to Coolify

This is the part that's manual for v1 (will be self-service in phase 5+). We do it on their behalf, on a screenshare.

1. SSO into `https://<slug>.western-communication.com/coolify` as the operator (you)
2. **Project → New** — `<customer-name>-prod`
3. **Resource → New → Public repository** — paste their git URL
4. Set environment variables (you have these from the migration prep)
5. Deploy. Watch the logs.

If they need a Postgres separate from the Supabase one, also:
1. **Resource → New → PostgreSQL**
2. Connect their app to it via env vars
3. Migrate data from their old DB (typically `pg_dump | psql`)

## 4.5 Add their custom domain

Once the app is healthy on `<slug>.western-communication.com/<their-app>`, add their real domain.

```bash
./scripts/add-custom-domain.sh \
  --slug <slug> \
  --domain <their-domain> \
  --target-app <coolify-app-name>
```

What the script does:

1. Calls Cloudflare for SaaS API to register `<their-domain>` as a custom hostname against our zone
2. Waits for the customer to add the CNAME to their DNS (we provide instructions)
3. Polls until validation passes (usually < 5 min)
4. Updates the customer VM's Caddyfile to route `<their-domain>` to the right Coolify backend
5. `caddy reload` on the customer VM
6. Updates the cloudflared ingress rules to accept `<their-domain>`
7. Updates the ops DB with the new domain

Customer gets an email/Slack from us with the CNAME they need to add — usually:

> Add this to your DNS:
> `www.<their-domain>` CNAME → `<their-domain>.cdn.cloudflare.net`

Cloudflare for SaaS handles the cert.

## 4.6 Cutover

The actual moment of switching their public traffic. Pick a low-traffic window (Tuesday 03:00 UTC for most B2B).

1. **T-30 min**: announce in our status page (planned maintenance)
2. **T-15 min**: final data sync from old host → new (e.g. `pg_dump | psql`, `rsync` for static)
3. **T**: customer changes their public DNS A/CNAME from old host → `<their-domain>.cdn.cloudflare.net`
4. **T+5 min**: DNS propagating, traffic starts arriving
5. **T+15 min**: confirm everything green via Uptime Kuma + their team's smoke tests
6. **T+30 min**: announce maintenance complete, mark the pilot as live in the ops DB

If anything goes wrong: customer reverts the DNS change. Old host keeps running for 7 days post-cutover as the rollback path.

## 4.7 The first 7 days

Daily check-in (15 min, Slack/email):

- Anything red on Uptime Kuma?
- Anything they tried to do they couldn't?
- Anything broken they think might be us?

After 7 days clean: we tear down the rollback (their old host can be released) and they're a permanent customer.

After 30 days clean: we ask for the written reference + case study agreed in the pre-pilot meeting.

## 4.8 Generalising backups for customers

By the end of the pilot, the backup-supabase.sh script (still v1, only backs up our own DB) needs generalising to back up the customer DB too.

Update `scripts/backup-supabase.sh` to:
1. Read the list of active customer slugs from the ops DB
2. For each, ssh to the customer VM and pg_dump every database in their Supabase Postgres
3. Push each to `b2:wcn-cloud-backups/<slug>/postgres/<date>.sql.gz`
4. Apply lifecycle: 7 daily + 4 weekly + 12 monthly + 7 annual

This is the script that runs nightly via cron on the Coolify VM (or, in phase 6+, on a dedicated runner VM).

## 4.9 Acceptance

Phase 4 is done when **all six** are true:

1. The pilot customer has been live for ≥ 7 days with no Sev1 incidents
2. They've successfully self-deployed at least one git push via Coolify
3. Their custom domain is resolving via Cloudflare for SaaS, valid SSL
4. Backups are running nightly and at least one restore drill has been performed (`runbooks/restore-database.md`)
5. They've been billed once and the invoice cleared
6. Optional but ideal: they've given us written feedback (good and bad)

## 4.10 Rollback (worst case)

If the pilot has to be aborted (customer pulls out, fundamental issue we can't fix):

1. **Migrate them back**: `pg_dump` from our VM → their old host. They change DNS back. We refund the pilot.
2. **Deprovision**: `deprovision-customer.sh --slug <slug>`
3. **Postmortem**: write up what we learned in `dc-deployment/postmortems/<date>-pilot.md`. Decide whether to retry or pause the SaaS plan.

We don't proceed to phase 5 until this phase has succeeded. If the pilot fails, the lessons go back into phase 0–3.

---

**Next:** `phases/05-custom-ui.md`
