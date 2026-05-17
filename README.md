# IaaS — full implementation plan

This folder is the working repository for turning the Dreadnaught DC server into a multi-tenant managed-hosting platform ("WCN Cloud" — substitute your final product name).

> **Status as of 2026-05-08:** plan only. No scripts have been run yet. Every file in this folder is either a plan, a script ready to run, or a config ready to deploy — but nothing in production knows about any of this yet.

## What's here

```
IaaS/
├── README.md                  ← you are here
├── ARCHITECTURE.md            ← the one-page summary of how it all fits
├── phases/                    ← step-by-step plan, executed sequentially
│   ├── 00-prerequisites.md
│   ├── 01-foundations.md
│   ├── 02-template-vm.md
│   ├── 03-provisioning.md
│   ├── 04-pilot.md
│   ├── 05-custom-ui.md
│   ├── 06-polish.md
│   └── 07-scale.md
├── scripts/                   ← real, runnable bash scripts
├── configs/                   ← Caddy, RouterOS, SQL, CSS — ready to deploy
├── console/                   ← Next.js custom UI scaffold
├── runbooks/                  ← ops procedures (one per common task)
└── tests/                     ← smoke-test checklists per phase
```

## How to use this folder

Read top-to-bottom, run phase-by-phase. Don't skip ahead — phase 4 (pilot customer) assumes phases 0–3 are done.

Each phase doc has:
- **Goal** (what this phase achieves)
- **Prerequisites** (what must be true before starting)
- **Steps** (numbered, with commands)
- **Acceptance criteria** (how you know it's done)
- **Rollback** (if things go wrong)

## Quickstart — what to do tomorrow morning

1. Read `ARCHITECTURE.md` (10 min)
2. Read `phases/00-prerequisites.md` (15 min)
3. Confirm the accounts/tokens listed in 00 (Cloudflare for SaaS, CF API token, CF Health Checks). Monitoring uses a Proxmox VM (created in phase 1) — no external VPS needed. Backups: see phase notes (RAID-image copy out of scope for this folder).
4. Once 00 acceptance passes, start `phases/01-foundations.md`

## Reference docs (outside this folder)

These docs in the parent `dc-deployment/` folder give context but are not required reading to execute:

- `managed-hosting-offering.md` — the customer-facing pitch + pricing model
- `multi-tenant-implementation.md` — high-level architecture rationale
- `whitelabel-and-automation.md` — why we build it this way
- `99-handover.md` — current production state of the underlying server

## Owners

- **Build owner:** Leo Wilson (`leo.wilson@westerncommunication.co.uk`)
- **Production change approver (WCN MikroTik):** Jake
- **Pilot customer (TBD):** to be confirmed in `phases/04-pilot.md`

## Conventions

- Date format: ISO `YYYY-MM-DD` everywhere
- Slugs: lowercase, alphanumeric + hyphens, 3–20 chars, must match `[a-z][a-z0-9-]{2,19}`
- VMID range for customers: 200–399 (templates 9000–9099, internal 100–199)
- IP range for customers: 10.10.31.10 – 10.10.31.200 (gateway .1, .2–.9 reserved for ops use)

## Critical safety rules (lifted from `CLAUDE.md` — do not violate)

1. **WCN MikroTik is live production** — Safe Mode mandatory before edits.
2. **Router :443 is owned by SSTP** — never dst-NAT.
3. **Public exposure via Cloudflare Tunnel only** — no inbound firewall changes.
4. **iLO never public**.
5. **Don't touch ether11/ether12 on `bridge_flat`**.
6. **Pre-existing concerns on the WCN router** (subnet collision etc.) — don't fix without Jake's authorisation.

These apply throughout this build. Phase 1 makes one production-impacting MikroTik change (adding VLAN 31); every other phase is server-side / Cloudflare / our own code.
