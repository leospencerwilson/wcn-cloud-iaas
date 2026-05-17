# Phase 5 — Custom console UI

**Goal:** customers no longer see the Coolify UI. They see `console.western-communication.com` (our white-labelled Next.js app), which mediates everything via signed Coolify API calls under the hood.

**Estimated time:** 4–6 weeks of focused dev (one engineer).

**Prerequisites:** phase 4 acceptance — at least one happy pilot.

---

## 5.1 Why we build this (vs. shipping Coolify white-labelled forever)

After ~10 customers, we hit pain with the Coolify-via-CSS-overlay approach:

1. **Branding is brittle**: each Coolify upgrade can break our overlay CSS.
2. **Some pages can't be hidden**: Coolify exposes things we don't want customers seeing (server metrics, internal routes).
3. **Surface area is too wide**: customers can do things we don't support yet (websocket terminals, raw SSH from the UI).
4. **Ops can't extend it**: we want extra screens (billing, support, our own runbook links). Coolify can't do that.

We don't want to **fork** Coolify (see `dc-deployment/whitelabel-and-automation.md` § "v3 — full fork: don't"). We build our own thin UI on top of Coolify's API.

## 5.2 Scope of v1 of the console

12 pages. Each replaces the equivalent in Coolify, hiding what's not needed.

| Page | Coolify equivalent | Our scope |
|---|---|---|
| `/` (dashboard) | `/dashboard` | List of projects, quick "deploy from git" |
| `/login` | (Cloudflare Access redirect) | Just shows a "Continue with SSO" button |
| `/projects` | `/project` | List of customer's projects |
| `/projects/:id` | `/project/:id/...` | Project overview: services, last deploy, logs |
| `/projects/:id/deploy` | `/project/:id/.../configuration` | Trigger a deploy from a branch |
| `/projects/:id/env` | `/project/:id/.../environment-variables` | Read/edit env vars |
| `/projects/:id/logs` | `/project/:id/.../logs` | Last 1000 lines of stdout/stderr |
| `/databases` | `/project/:id/database` | Their Supabase + extra Postgres DBs |
| `/databases/:id/backups` | (custom) | List of backups with one-click restore |
| `/domains` | (custom) | Their custom domains, status, "add new" |
| `/team` | `/project/:id/...team` | Invite admins, set permissions |
| `/billing` | (custom) | Invoices, plan, upgrade/downgrade |

What we explicitly do **not** show in v1:
- Server-level metrics (CPU/disk/RAM) — they don't have a server, we do
- Logs older than 24h (need a log retention service first; we punt to phase 6)
- Webhooks (advanced — punt)
- Application stack templates beyond Next.js / Node / Postgres (advanced — punt)

## 5.3 Architecture of the console

```
console.western-communication.com  ← Cloudflare Access JWT enforced
        │
        ▼
   Next.js App Router  (deployed via our own Coolify, on 10.10.30.10)
        │
        ├── lib/auth.ts       ← validates Cf-Access-Jwt-Assertion header against CF JWKs
        │                       returns { email, customer_slug } from JWT + ops DB lookup
        │
        ├── lib/coolify.ts    ← thin client around the customer's per-VM Coolify API
        │                       (with the per-customer signing token)
        │
        ├── lib/cloudflare.ts ← CF SaaS API client for custom-hostname operations
        │
        ├── lib/db.ts         ← Postgres client for the ops DB
        │
        └── lib/tenant.ts     ← given email → customer record → which Coolify VM to talk to
```

Auth flow on every request:
1. Browser hits `console.western-communication.com/projects`
2. CF Access intercepts; if no JWT cookie, redirects to Entra ID
3. Once authed, CF Access proxies the request with `Cf-Access-Jwt-Assertion` header
4. Next.js middleware verifies the JWT (cached JWKs)
5. Looks up `email → customer slug` in ops DB
6. Stores `{ email, customer_slug, role }` on the request
7. Page renders, server actions use `lib/coolify.ts` scoped to this customer's Coolify VM

## 5.4 Build order

Week-by-week breakdown (one mid-level engineer):

### Week 1 — scaffolding
- Set up Next.js App Router project at `IaaS/console/`
- `lib/auth.ts` — JWT verify + middleware
- `lib/db.ts` — ops DB read/write helpers
- `lib/tenant.ts` — email-to-customer resolver
- Login flow happy path: `/login` → Access → `/` shows "Hello, you're tenant X"
- Deploy via our own Coolify, behind Access. Test with multiple emails.

### Week 2 — projects + deploys
- `lib/coolify.ts` — client for Coolify's API. Uses per-customer signing token (from ops DB).
- `/projects` and `/projects/:id` pages
- Deploy-from-git form (branch picker, deploy button)
- Webhook from Coolify back to us (for "deploy succeeded/failed" notifications) — async

### Week 3 — env + logs
- `/projects/:id/env` page (CRUD env vars)
- `/projects/:id/logs` (streaming via SSE from Coolify)
- Pagination, search

### Week 4 — domains + databases
- `/domains` — list, add, remove. Calls `add-custom-domain.sh` via a backend job runner.
- `/databases` — list. Show connection string (with password masked, copy-to-clipboard reveals it).
- `/databases/:id/backups` — list, restore button (kicks off `restore-customer.sh`)

### Week 5 — team + billing + polish
- `/team` page
- `/billing` page (read-only for v1, just shows the current plan and the next invoice from Stripe)
- Empty-state design, loading skeletons, toasts on success
- Mobile responsiveness

### Week 6 — internal beta + cutover
- Deploy to staging hostname (e.g. `console-staging.western-communication.com`)
- Internal eval: have 2 ops users try it for a day
- Fix issues, repeat
- Cut over the pilot customer: they switch from `<slug>.western-communication.com/coolify` to `console.western-communication.com`

## 5.5 Key files to create

```
IaaS/console/
├── package.json
├── next.config.js
├── tsconfig.json
├── middleware.ts                    ← JWT verify, attach tenant context
├── app/
│   ├── layout.tsx                   ← global layout with our brand
│   ├── page.tsx                     ← / dashboard
│   ├── login/page.tsx
│   ├── projects/page.tsx
│   ├── projects/[id]/page.tsx
│   ├── projects/[id]/env/page.tsx
│   ├── projects/[id]/logs/page.tsx
│   ├── projects/[id]/deploy/page.tsx
│   ├── databases/page.tsx
│   ├── databases/[id]/backups/page.tsx
│   ├── domains/page.tsx
│   ├── team/page.tsx
│   └── billing/page.tsx
├── lib/
│   ├── auth.ts                      ← verify Cf-Access-Jwt-Assertion
│   ├── coolify.ts                   ← thin wrapper around Coolify v3 API
│   ├── cloudflare.ts                ← CF SaaS client
│   ├── db.ts                        ← postgres + ops DB access
│   ├── tenant.ts                    ← email → tenant resolver
│   └── jobs.ts                      ← async job runner (BullMQ or pg_boss)
├── components/
│   ├── nav.tsx
│   ├── empty-state.tsx
│   ├── log-stream.tsx
│   └── env-editor.tsx
└── public/
    └── (branding assets)
```

A starter scaffold of these files lives in `IaaS/console/`. Most are minimal but show the skeleton (auth wiring, DB connection, layout, one full page implementation) — the rest is mechanical.

## 5.6 Migrating customers from the Coolify-direct UI

For each existing customer (after we've validated the new console internally):

1. Email them: "We're moving to a new console. Here's what's different. Old UI works for 30 more days, new one is at console.western-communication.com."
2. Add their email to the new console's Access policy
3. Update their welcome materials (PDFs / loom videos) to point to the new URL
4. After 30 days: disable Cloudflare Access policies on `<slug>.western-communication.com/coolify` (they get 401 if they try the old URL)
5. Coolify on each VM stays running — just no longer end-user-accessible. We still use it directly for ops.

## 5.7 Acceptance

Phase 5 is done when **all five** are true:

1. The pilot customer has switched to the new console exclusively for ≥ 14 days
2. All 12 v1 pages exist and pass an internal usability review
3. No "raw Coolify URL" is accessible by a customer (Access denies it)
4. The console can handle ≥ 10 concurrent customer sessions without trouble
5. Operator can also use the console (with elevated permissions) to debug — no need to drop into per-VM Coolify for routine ops

## 5.8 Rollback

If the new console fails badly post-cutover:

1. Re-enable the Access policy on `<slug>.western-communication.com/coolify` for the customer in question
2. Email them: "We've reverted you to the previous console while we fix X. No data lost."
3. Postmortem.

The Coolify-on-per-VM is always running, regardless of whether the new console is up. So this rollback is < 5 min.

---

**Next:** `phases/06-polish.md`
