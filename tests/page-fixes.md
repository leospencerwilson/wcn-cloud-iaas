# Console Page-by-Page Fixes & Tests

Tracking issues found while walking through prod (`console.western-communication.com`) and tests to be written for each page. Started 2026-05-30.

Legend: `[ ]` open · `[x]` done · `(test)` indicates a test to write

---

## Public

### `/` (landing)
- [ ] _findings TBD_
- [ ] (test) renders Sign in CTA when unauthenticated
- [ ] (test) redirects to `/dashboard` when authenticated

### `/login`
- [ ] **Visual/UX inconsistency** — login page styling/layout doesn't match the rest of the console. Needs to be brought in line with the design system used elsewhere (typography, spacing, button styles, card/container treatment). _Details TBD on next pass._
- [ ] **No loading state on Sign in button** — after pressing Sign in, the button just hangs for ~5s with no feedback. Add a spinner / disabled state on the button while the auth request is in flight so users don't double-click or assume it's broken.
- [ ] (test) email + password fields present, submit posts to `/api/auth/login`
- [ ] (test) shows error on bad creds
- [ ] (test) redirects to `?next=` on success

### `/invite/[token]`
- [ ] _findings TBD_

### `/team/accept`
- [ ] _findings TBD_

### `/status/[slug]`
- [ ] _findings TBD_

---

## Dashboard (customer)

### `/dashboard`
- [ ] _findings TBD_

### `/dashboard/apps`
- [ ] _findings TBD_

### `/dashboard/apps/new`
- [ ] _findings TBD_

### `/dashboard/apps/[id]`
- [ ] _findings TBD_

### `/dashboard/apps/[id]/console`
### `/dashboard/apps/[id]/cron`
### `/dashboard/apps/[id]/deploy`
### `/dashboard/apps/[id]/deployments/[deploy_id]`
### `/dashboard/apps/[id]/domains`
### `/dashboard/apps/[id]/domains/[hostname]/cert`
### `/dashboard/apps/[id]/domains/redirects`
### `/dashboard/apps/[id]/env`
### `/dashboard/apps/[id]/logs`
### `/dashboard/apps/[id]/metrics`
### `/dashboard/apps/[id]/secrets`

### `/dashboard/api-tokens`
### `/dashboard/audit`
- [ ] **Audit trail UX overhaul** — current view is a flat dump. Needs:
  - Pagination (or infinite scroll) — don't render all events at once.
  - Filters: by actor, action/event type, resource, date range, success/failure.
  - Sortable columns (timestamp asc/desc at minimum).
  - Search box (free-text over actor/resource/event).
  - Same improvements should apply to `/admin/customers/[slug]/audit`.
- [ ] (test) page renders with paginated results and respects `?page=` / `?limit=`
- [ ] (test) filter query params (`actor`, `action`, `from`, `to`) narrow results correctly
### `/dashboard/backups`
### `/dashboard/coolify`
### `/dashboard/database`
### `/dashboard/domains`
### `/dashboard/environment`
### `/dashboard/health`
### `/dashboard/supabase`
### `/dashboard/team`

---

## Admin

### `/admin`
- [ ] **Remove "Fleet, at a glance." heading** (`console/app/admin/page.tsx:18`).
- [ ] **Add fleet health row** — current stat tiles (Customers / Active users / Pending invites) show headcount only, nothing operational. Add tiles for: failing jobs, firing alerts, and capacity headroom (CPU / disk %). Pull from the same sources `/admin/alerts` and `/admin/capacity` already use.
- [ ] **Audit timestamps as relative time** — `new Date(row.ts).toISOString()` (`console/app/admin/page.tsx:50`) is hard to scan. Render as relative ("3m ago", "2h ago") with the full ISO timestamp on hover (`title=`). Apply the same treatment everywhere audit/event rows appear.
### `/admin/alerts`
### `/admin/bulk`
### `/admin/bulk/new`
### `/admin/bulk/[id]`
### `/admin/capacity`
### `/admin/customers`
- [ ] **Header copy cleanup** (`console/app/admin/customers/page.tsx:53-60`):
  - Rename eyebrow `§ FLEET` → `§ CUSTOMERS`.
  - Remove the `Active deployments.` h1.
  - Remove the "Every customer currently on WCN Cloud. Click a row for details." subtitle.
- [ ] **Column label clarity** — rename `Contact` → `Primary email` and `Name` → `Company name` (the `name` field is the company/display name, `contact_email` is the primary account email). Apply consistently anywhere these fields surface (customer detail page, create form, etc.).
- [ ] **Heartbeat blocks render** — `Promise.all` over `heartbeat()` (`console/app/admin/customers/page.tsx:41`) holds the entire page until every VM responds (1.5s timeout each). Stream the table with `<Suspense>` and resolve live dots client-side (e.g. `useSWR` against a `/api/admin/customers/[slug]/heartbeat` endpoint) so the table paints instantly.
- [ ] **Add search / filter / sort** — search by slug, name, or contact; filter by tier and status; sortable columns. List becomes unusable past ~20 rows.
- [ ] **Pagination (or virtualization)** — pair with the above.
- [ ] **Make whole row clickable, once** — currently every cell wraps its own `<Link>` (multiple focusable elements per row, noisy DOM). Replace with a single row-level click handler / link overlay.
- [ ] **Richer live-status UX** — on hover show response time + last-checked timestamp; allow user-triggered recheck.
- [ ] **Date column → relative time** — `new Date(c.created_at).toISOString().slice(0, 10)` (`page.tsx:126`) should render relative ("3d ago") with ISO on hover, consistent with audit.
- [ ] **Bulk actions** — multi-select rows → bulk reboot / snapshot / message, wired into `/admin/bulk`.
- [ ] **Summary line above table** — e.g. "12 customers · 10 online · 1 rebooting · 1 offline" so ops can scan health at a glance.
### `/admin/customers/new`
- [ ] **Field labels** — rename `Display name` → `Company name`, `Contact email` → `Primary email` (`console/app/admin/customers/new/page.tsx:43,61`); match the list-page rename.
- [ ] **Live slug validation + preview** — currently only the HTML `pattern` (`page.tsx:31`). Add JS validation, render a live preview (`<slug>.western-communication.com`) under the field, and a debounced duplicate-slug check against an API before submit.
- [ ] **Tier dropdown sourced from `/admin/tiers`** — replace the hardcoded `site / site-db / pro` `<select>` (`page.tsx:48-58`) with options pulled from the new tiers page, including their resource/price defaults.
- [ ] **Auto-suggest slug from company name** — typing "Acme Ltd" → suggests `acme`, user can edit.
- [ ] **Add missing fields** — decide where to capture: billing contact, technical contact, billing address (VAT/invoicing), free-text notes, expected go-live date. Either add to this form or to the customer detail page; currently captured nowhere.
- [ ] **Submit feedback + post-create redirect** — provisioning is async/long. Show a pending spinner on the Create button, then redirect to `/admin/customers/[slug]` with a "Provisioning…" banner.
- [ ] **Subtitle copy rewrite** — "Records a customer in the ops database — actual VM provisioning is handled by the orchestrator script." (`page.tsx:17-19`) is unhelpful. Clarify what happens next (does this trigger the orchestrator? if not, link to the runbook).
- [ ] **Server-side error surfacing** — `createCustomerAction` throws (duplicate slug, DB error) currently surface as nothing useful. Render errors inline on the form.
- [ ] **Confirmation step for tier defaults** — once tiers carry pricing/resources, show a "This will provision a Pro tier (£X/mo, 4 vCPU, 8 GB)" confirm before submit.
- [ ] (test) form validates slug pattern client-side and server-side; duplicate slug rejected.
- [ ] (test) successful create redirects to `/admin/customers/[slug]` and surfaces provisioning state.
- [ ] (test) server errors render inline without losing form state.
### `/admin/customers/[slug]` (overview)
- [ ] **Icons on VM action buttons** — Start / Stop / Restart buttons in `VmOperations` (`console/app/admin/customers/[slug]/vm-operations.tsx`) are text-only. Add icons (play / stop / refresh) inline with the labels for faster visual parsing.
- [ ] **Move VM actions into the identity header** — lift Start / Stop / Restart (and Impersonate) out of the `VmOperations` section and place them inline in the customer header next to `test1 · Tier site · provisioning`. They're the most-used controls; they belong with identity, not buried in a section below.
- [ ] **All tools into tabs at the top** — layout currently has Overview / Coolify / Supabase / Health tabs. Move every tool (Metrics, VM resize / Operations, Snapshots, Backups, Alerts, Audit log, Last provisioner job) into the same top tab strip, organised into logical groups (e.g. Overview · Metrics · Operations · Snapshots · Backups · Alerts · Audit · Coolify · Supabase · Health · Jobs). Drop the in-page TOOLS and ADMIN list sections once tabs cover them.
- [ ] **Last-job row needs more** — currently shows raw UUID (`page.tsx:151`). Truncate to 8 chars + copy-on-click, plus status pill (succeeded/failed) and finished-at. Also show the last ~5 jobs, not just the latest one.
- [ ] **Impersonate button placement** — currently sits next to "Proxmox + cloudflared tunnel" caption inside the VM section (`page.tsx:29-30`). Move into the (layout) customer identity header next to the slug/tier, where it belongs.
- [ ] **No edit affordance** — name, tier, contact email aren't editable from this page. Add inline-edit or a Settings sub-page.
- [ ] **No danger zone** — no UI to deprovision / archive / hard-delete a customer. `deprovision-customer` script exists; surface it here behind a confirm-by-typing-slug gate.
- [ ] **VM card too thin** — only VM ID / IP / status / host (`page.tsx:36-57`). Add vCPU, RAM, disk size/used, uptime, last boot, current load.
- [ ] **Inline audit preview** — show last ~5 audit events as a section here with "View all" → `/admin/customers/[slug]/audit`, so admins see recent activity on landing.
- [ ] **Quick links to external systems** — Proxmox VM URL, Coolify URL, Cloudflare tunnel record. One-click jump-out.
- [ ] **Collapse empty ADMIN section** — when `customer.last_job_id` is null the section is dead weight (`page.tsx:156-159`). Hide it, or merge the single "Last provisioner job" row into TOOLS.
- [ ] (test) renders identity, VM card, TOOLS list when VM allocated.
- [ ] (test) hides VM-dependent sections when `vm` is null.
### `/admin/customers/[slug]/alerts`
### `/admin/customers/[slug]/audit`
### `/admin/customers/[slug]/backups`
### `/admin/customers/[slug]/coolify`
### `/admin/customers/[slug]/health`
### `/admin/customers/[slug]/jobs/[jobId]` (provisioning log)
- [ ] **"Back to fleet" → "Back to customers"** (`console/app/admin/customers/[slug]/jobs/[jobId]/page.tsx:38`) — match the rename elsewhere.
- [ ] **Add job context to header** — started-at, live-ticking elapsed time, current phase/step name. Long provisions run minutes; "Running" alone tells you nothing.
- [ ] **Phase/step checklist** — orchestrator runs a known sequence (VM create → cloud-init → Coolify install → Supabase up → DNS → tunnel). Detect markers in the log stream and render a checklist that ticks off, instead of a single status pill.
- [ ] **ANSI color rendering** — log pane (`job-log.tsx:116-138`) renders raw text; ANSI escape sequences from the orchestrator will show as garbage. Strip or use an ANSI-to-HTML renderer.
- [ ] **Copy + download log** — buttons to copy buffer to clipboard and download full log as `.txt`. Critical for sharing failures.
- [ ] **In-pane search** — filter / highlight matches / jump to next; native Ctrl-F is useless on long buffers.
- [ ] **Auto-scroll indicator** — `autoScroll.current` flips silently on scroll-up (`job-log.tsx:77-82`). Show a "↓ Jump to latest" pill when paused so the user knows they've broken auto-follow.
- [ ] **Reconnect on stream loss** — `lost` is currently terminal in the UI (`job-log.tsx:65-67`). Add a "Retry" button and a couple of automatic exponential-backoff reconnects before giving up.
- [ ] **Persist & resume** — reloading mid-provision wipes the in-memory buffer. Either replay the stream from the start via `EventSource` resume, or fetch the persisted log from DB on mount.
- [ ] **Failure UX** — on `failed`, surface the reason prominently (last non-empty stderr line, exit code, which phase failed) with "Retry job" / "Open runbook" actions.
- [ ] **Cancel/abort button** — for stuck jobs; wire to the orchestrator's cancel endpoint.
- [ ] **Link back to customer detail** — header shows the slug as plain text (`page.tsx:22`); link to `/admin/customers/[slug]`.
- [ ] **Truncate job UUID** — show first 8 chars in the subtitle (`page.tsx:27`) with copy-full-id on click.
- [ ] **Distinct color for `lost`** — currently same red as `failed` (`job-log.tsx:18`); use amber/yellow so "we don't know" doesn't read as "it failed".
- [ ] (test) status transitions render correctly (connecting → running → succeeded/failed/lost).
- [ ] (test) log lines append and auto-scroll until user scrolls up, then "Jump to latest" appears.
- [ ] (test) reload mid-job restores prior log buffer.
### `/admin/customers/[slug]/metrics`
### `/admin/customers/[slug]/operations`
### `/admin/customers/[slug]/snapshots`
### `/admin/customers/[slug]/supabase`
### `/admin/invites`
### `/admin/invites/new`

---

## New pages / sections to build

### `/admin/tiers` (new)
- [ ] **Define customer tiers** — need a dedicated admin tab/page to manage tier definitions (Bronze/Silver/Gold/etc.): name, resource limits (vCPU, RAM, disk, bandwidth), feature flags, backup cadence, support SLA, monthly price. Today tier is just a string field on the customer row with no source of truth.
- [ ] CRUD on tier definitions (create, edit, archive — never hard-delete if customers reference it).
- [ ] Surface tier on `/admin/customers` and `/admin/customers/[slug]` (link from the Tier cell/field to the tier definition page).
- [ ] Selecting a tier on `/admin/customers/new` should pull defaults from this source rather than free-text input.
- [ ] (test) tier list renders; create/edit/archive flow; preventing delete when customers reference the tier.

---

## Test infra notes

- [ ] No test runner configured in `console/package.json` — decide: **Playwright** (browser E2E, fits this walkthrough) vs **Vitest + RTL** (component) vs both.
- [ ] Add CI hook once chosen.
