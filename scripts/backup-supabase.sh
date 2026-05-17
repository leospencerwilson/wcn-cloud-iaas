#!/usr/bin/env bash
# Backup orchestrator. Run by cron on the Coolify VM (10.10.30.10).
#
# Phase 1: backs up our own ops Postgres only.
# Phase 4+: backs up every active customer's Supabase Postgres too.
#
# Usage: backup-supabase.sh [--slug <one-customer-slug>]   for ad-hoc single-customer

source "$(dirname "$0")/common.sh"
require_env OPS_DB_URL B2_KEY_ID B2_APP_KEY
require_cmd rclone psql ssh docker

ONLY_SLUG=""
[[ "${1:-}" == "--slug" ]] && ONLY_SLUG="${2:?slug arg required}"

ts=$(date -u +%Y%m%dT%H%M%SZ)
WORK=$(mktemp -d -p /tmp wcn-backup-XXXXXX)
trap 'rm -rf "$WORK"' EXIT

success_log="/var/log/wcn-cloud/backup-status.log"
mkdir -p "$(dirname "$success_log")"

backup_one() {
  local label="$1"      # e.g. "ops" or "customer-acme"
  local prefix="$2"     # b2 prefix, e.g. "ops" or "acme/postgres"
  local cmd="$3"        # command that writes pg_dumpall to stdout

  local file="${WORK}/${label}-${ts}.sql.gz"
  log "Dumping $label..."
  if ! eval "$cmd" | gzip > "$file"; then
    err "$label: pg_dumpall failed"
    echo "FAIL $(date -u +%FT%TZ) $label" >>"$success_log"
    return 1
  fi
  size=$(stat -c%s "$file")
  log "  $label: $(du -h "$file" | cut -f1)"

  if ! rclone copy --quiet "$file" "b2:wcn-cloud-backups/${prefix}/"; then
    err "$label: rclone copy failed"
    echo "FAIL $(date -u +%FT%TZ) $label" >>"$success_log"
    return 1
  fi
  echo "OK   $(date -u +%FT%TZ) $label size=${size}" >>"$success_log"
  ok "  $label uploaded to b2:wcn-cloud-backups/${prefix}/"
}

# ── 1. ops DB ──────────────────────────────────────────────────────────
if [[ -z "$ONLY_SLUG" ]]; then
  backup_one "ops" "ops" "pg_dump '$OPS_DB_URL'"
fi

# ── 2. each active customer ───────────────────────────────────────────
# Skip 'site' tier (no DB).
slug_filter=""
[[ -n "$ONLY_SLUG" ]] && slug_filter="AND c.slug='$ONLY_SLUG'"

while IFS='|' read -r slug ip; do
  [[ -z "$slug" ]] && continue
  if ! ssh -o ConnectTimeout=5 ops@"$ip" 'echo ok' &>/dev/null; then
    warn "$slug (${ip}) unreachable, skipping"
    echo "SKIP $(date -u +%FT%TZ) $slug unreachable" >>"$success_log"
    continue
  fi
  cmd="ssh ops@${ip} 'docker exec \$(docker ps -q -f name=supabase-db) pg_dumpall -U postgres'"
  backup_one "customer-${slug}" "${slug}/postgres" "$cmd"
done < <(ops_db -c "
  SELECT c.slug, v.ip
  FROM customers c JOIN vms v ON v.customer_slug = c.slug
  WHERE c.status='active' AND c.tier IN ('site-db','pro') AND v.status='active' $slug_filter
  ORDER BY c.slug")

# ── 3. retention via B2 lifecycle (set up once, see ops-db-schema.sql comments) ──
# We rely on B2 bucket lifecycle to retain 7 daily / 4 weekly / 12 monthly / 7 annual.

ok "Backup run complete: $(date -u +%FT%TZ)"
