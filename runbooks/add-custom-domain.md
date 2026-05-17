# Runbook: add a custom domain for a customer

**Use when:** customer wants their app accessible on their own domain (e.g. `app.acme.com`).

**Owner:** ops on shift.

**Time:** 5–30 min (depending on how fast the customer adds the CNAME).

---

## 1. Confirm the request

The customer should have:
- Confirmed which domain they want (one at a time — repeat for multiples)
- Confirmed they have DNS control for that domain (or someone they can ask)
- Decided which Coolify app the domain should route to (default: their primary app)

## 2. Run the script

```bash
./scripts/add-custom-domain.sh \
  --slug acme \
  --domain app.acme.com
```

The script:
1. Registers the hostname against our Cloudflare for SaaS zone (instant)
2. Pauses and prints the CNAME the customer needs to add
3. Polls until validation succeeds (≤ 5 min after they update DNS)
4. Updates the customer VM's tunnel ingress + Caddyfile
5. Confirms with a curl

## 3. While the script polls — message the customer

Send them this verbatim:

```
Hi <name>,

To get app.acme.com pointing to WCN Cloud, please add this DNS record:

  Type:    CNAME
  Name:    app  (or "app.acme.com" depending on your DNS provider)
  Target:  acme.app.western-communication.com
  TTL:     auto / 300 (5 min)

Once added, our system will detect it within ~5 minutes and issue
an SSL certificate automatically. You don't need to do anything else.

Reply once you've added it — we'll confirm it's live within 10 minutes.
```

## 4. Confirm

Once the script reports success:

```bash
curl -fI https://app.acme.com
# expected: 200 (or whatever their app returns), valid SSL
```

Reply to the customer:

```
Confirmed — https://app.acme.com is live.

Note: it can take a few hours for DNS to fully propagate worldwide,
so visitors on slower DNS resolvers may see the change with a delay.
```

## 5. Update internal record

The script writes to the ops DB, but mark in CRM too:

- Customer record → Custom domains: add `app.acme.com`
- If this is their first custom domain, mark the milestone in their account notes.

## Troubleshooting

**Script hangs after 10 min on validation polling**

Customer hasn't added DNS yet. Politely chase. The script can be cancelled
with Ctrl-C and re-run with the same args once they've added the record (it's idempotent).

**SSL certificate stuck in `pending_validation`**

Check the validation TXT record — Cloudflare requires a TXT for DCV. If
the customer's DNS provider doesn't support TXT records on apex (rare),
flip the SSL method from `txt` to `http` (manual edit in CF dashboard,
takes effect on next poll).

**Customer's CNAME is on the apex**

Most DNS providers can't CNAME the apex (`acme.com` itself, no subdomain).
Options:
1. Use a subdomain (`www.acme.com` is the conventional choice)
2. Use a CNAME flattening provider (Cloudflare DNS itself supports this)
3. Set up a redirect from apex → www on their existing host

**Domain shows as "moved" in CF**

The customer has the same hostname pointing to a different SaaS provider.
We can't claim it until they release. Tell them to remove the old CNAME first.
