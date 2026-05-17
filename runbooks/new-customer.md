# Runbook: onboard a new customer

**Use when:** a new customer has signed up + paid the first invoice.

**Owner:** ops on shift.

**Time:** 30 min start to "customer can log in".

---

## 1. Pre-flight (5 min)

- [ ] Customer is in our CRM with: company name, primary contact email, tier they bought, primary domain
- [ ] First invoice paid (don't provision before payment clears)
- [ ] Slug agreed (lowercase, no spaces, e.g. `acme`, `bright-bakery`)
- [ ] Brand colour from customer (optional — defaults to ours)

## 2. Provision (20 min)

```bash
cd "C:/Users/LeoWilson/server project/IaaS"

# Source secrets (from your password vault)
source ~/.config/wcn-cloud/env

./scripts/provision-customer.sh \
  --slug acme \
  --tier pro \
  --domain acme.com \
  --email admin@acme.com \
  --name "Acme Ltd" \
  --brand-colour "#ff5500"
```

Watch the output. If anything fails, the script tells you which step. Re-run
with `--resume` after fixing.

## 3. Verify (3 min)

```bash
./scripts/customer-health-check.sh acme
```

Should print "All health checks passed".

## 4. Send the welcome email (2 min)

Use this template. Subject: **"Welcome to WCN Cloud — your account is ready"**

```
Hi <first name>,

Your WCN Cloud account is ready. Here's everything you need.

──────────────────────────────────────────
 Your console: https://console.western-communication.com
 Sign in:      Click "Continue with Microsoft" and use <admin email>
──────────────────────────────────────────

Once logged in, you can:
  • Deploy from a Git repo (GitHub / GitLab / Bitbucket)
  • Manage environment variables
  • View live application logs
  • Manage your Postgres database (and run backups)
  • Add custom domains

If you want to use your own domain (<their-domain>), let us know
when you're ready and we'll set it up — usually 5 minutes.

Need help? Reply to this email or write cloud-support@western-communication.com.

— Leo / WCN
```

If they're a Site+DB or Pro tier, also include the Supabase / DB onboarding
quickstart (1-page PDF in `branding/onboarding/db-quickstart.pdf`).

## 5. Add them to the status page subscribers (1 min)

Cachet → Subscribers → Add → `<their email>`. Auto-emails them on incidents.

## 6. Schedule the 7-day check-in (in your calendar)

A 15 min call or async check 7 days after onboarding. Discuss anything they
struggled with. This is the most important "are they sticking?" signal.

---

**Done.** Drop a note in #wcn-cloud-ops Slack: `provisioned acme @ <ts>`.
