# Smoke tests

Run after each phase, after each major change, and weekly as a hygiene check.

Each section maps to a phase. The intent is "if this passes, the phase outputs are still working." If something fails, **stop** and investigate before doing anything else.

Times shown are typical for a clean run. Multiply by 2× if anything's slow.

---

## Phase 0 — Prerequisites (~5 min)

```bash
# Cloudflare token
curl -s -H "Authorization: Bearer $CF_API_TOKEN" \
  https://api.cloudflare.com/client/v4/user/tokens/verify | jq -e '.success == true'

# B2 reachable
rclone lsd b2:wcn-cloud-backups >/dev/null

# Cloudflare Health Checks API reachable on the zone
curl -s -H "Authorization: Bearer $CF_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/healthchecks" \
  | jq -e '.success == true'

# Branding files present
ls "C:/Users/LeoWilson/server project/branding/" | grep -E "logo.svg|favicon" >/dev/null
```

All four must succeed.

## Phase 1 — Foundations (~5 min)

```bash
# VLAN 31 reachable from Proxmox
ssh root@192.168.50.50 'ping -c 1 -W 2 10.10.31.1' >/dev/null

# Ops DB schema present
psql "$OPS_DB_URL" -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';" \
  | grep -q 4

# B2 has at least one backup
rclone ls b2:wcn-cloud-backups/ops/ | wc -l | grep -qv '^0$'

# Internal monitor VM responsive (Uptime Kuma)
curl -fI -o /dev/null -m 5 http://10.10.30.20:3001 || echo "monitor unreachable"

# Cloudflare Health Check exists for console
curl -s -H "Authorization: Bearer $CF_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/healthchecks" \
  | jq -e '[.result[] | select(.name=="console")] | length >= 1'

# Proxmox API token works
curl -k -s -H "Authorization: PVEAPIToken=$PROXMOX_API_TOKEN" \
  https://192.168.50.50:8006/api2/json/version | jq -e '.data.release'
```

## Phase 2 — Template VM (~3 min)

```bash
# Template exists
ssh root@192.168.50.50 'qm list' | grep -q "^.*9001.*tpl-coolify-supabase"

# Template is stopped (templates can't be running)
ssh root@192.168.50.50 'qm status 9001' | grep -q stopped

# Template snapshot exists
ssh root@192.168.50.50 'qm listsnapshot 9001' | grep -q v1-baseline
```

## Phase 3 — Provisioning (~8 min)

End-to-end provision-deprovision cycle. **This actually runs the orchestrator** — doesn't reuse a long-lived test customer because we want to verify the script itself.

```bash
slug="smoke-$(date +%s)"

./scripts/provision-customer.sh \
  --slug "$slug" \
  --tier pro \
  --domain "${slug}.example.com" \
  --email leo.wilson@westerncommunication.co.uk \
  --name "Smoke Test"

./scripts/customer-health-check.sh "$slug"

./scripts/deprovision-customer.sh --slug "$slug" --force

# Confirm cleanup
qm_count=$(ssh root@192.168.50.50 "qm list" | awk '$2 ~ /'"$slug"'/' | wc -l)
[[ "$qm_count" -eq 0 ]] || { echo "VM not destroyed"; exit 1; }

dns=$(dig +short "${slug}.app.western-communication.com")
[[ -z "$dns" ]] || { echo "DNS not removed"; exit 1; }

status=$(psql "$OPS_DB_URL" -At -c "SELECT status FROM customers WHERE slug='$slug'")
[[ "$status" == "deleted" ]] || { echo "DB row not marked deleted"; exit 1; }
```

## Phase 4 — Pilot (continuous)

Run **daily**, automated, against the live pilot customer.

```bash
slug="<pilot-slug>"

./scripts/customer-health-check.sh "$slug"

# Their console hostname returns 302 (Access redirect — expected)
status=$(curl -s -o /dev/null -w "%{http_code}" "https://${slug}.app.western-communication.com/coolify")
[[ "$status" =~ ^(200|302|401)$ ]] || { echo "Unexpected status: $status"; exit 1; }

# Their custom domain (if they have one) is up
curl -fI "https://<their-custom-domain>" >/dev/null

# Backup ran in the last 36h
latest=$(rclone ls "b2:wcn-cloud-backups/${slug}/postgres/" | sort | tail -n1 | awk '{print $2}')
ts=$(echo "$latest" | grep -oE '[0-9]{8}T[0-9]{6}Z')
age_hours=$(( ($(date +%s) - $(date -d "${ts:0:4}-${ts:4:2}-${ts:6:2} ${ts:9:2}:${ts:11:2}:${ts:13:2}Z" +%s)) / 3600 ))
[[ "$age_hours" -lt 36 ]] || { echo "Last backup is $age_hours hours old"; exit 1; }
```

## Phase 5 — Custom UI (~3 min)

```bash
# Console responds (will be a 302 to Cloudflare Access)
curl -s -o /dev/null -w "%{http_code}\n" https://console.western-communication.com | grep -qE "^(200|302)$"

# After Access, the dashboard loads (run interactively in a browser)
echo "Manually verify: log into https://console.western-communication.com — see dashboard"

# Type-check + lint passes on the console code
( cd console && pnpm typecheck && pnpm lint )
```

## Phase 6 — Polish (~5 min)

```bash
# Telegraf is reporting from at least one customer VM
curl -s "https://metrics.western-communication.com/api/v2/query?org=wcn" \
  --data-urlencode 'q=from(bucket: "wcn-cloud") |> range(start: -10m) |> count()' \
  | grep -q '_value'

# Status page is up + reflects actual state
status=$(curl -s https://status.western-communication.com/api/v1/components | jq -r '.data[].status_name')
echo "$status"  # eyeball: should match reality
```

## Phase 7 — Scale

No automated smoke tests — these are decisions, not running systems.

---

## Continuous (run hourly via cron on the ops VM)

```bash
# Aggregated health check across all active customers
for slug in $(psql "$OPS_DB_URL" -At -c "SELECT slug FROM customers WHERE status='active'"); do
  ./scripts/customer-health-check.sh "$slug" >/dev/null \
    || ./scripts/incident.sh declare --severity major \
         --title "Customer $slug failing health checks" \
         --message "Automated check failed at $(date -u +%FT%TZ)"
done
```

If any customer fails, it auto-pages.
