#!/usr/bin/env bash
# Hourly: walk backup_policies, trigger backup-supabase.sh for any
# customer whose policy is due. Run by systemd timer.
set -euo pipefail

source /etc/wcn-cloud/provisioner.env

now_iso=$(date -u -Iseconds)
hour_now=$(date -u +%H)

psql "$OPS_DB_URL" -t -A -F'|' -c "
  SELECT customer_slug, frequency, time_utc::text, last_run_at, enabled
    FROM backup_policies WHERE enabled = true
" | while IFS='|' read -r slug frequency time_utc last_run enabled; do
  [[ -z "$slug" ]] && continue
  policy_hour="${time_utc%%:*}"

  # Determine "is due now?"
  due=false
  case "$frequency" in
    hourly) due=true ;;
    daily)
      if [[ "$hour_now" == "$policy_hour" ]]; then
        if [[ -z "$last_run" ]] || (( $(date -d "$last_run" +%s) < $(date -u -d "today $time_utc" +%s) )); then
          due=true
        fi
      fi
      ;;
    weekly)
      # Run on Sunday at policy hour
      if [[ "$(date -u +%u)" == "7" && "$hour_now" == "$policy_hour" ]]; then
        if [[ -z "$last_run" ]] || (( $(date -d "$last_run" +%s) < $(date -u -d "today $time_utc" +%s) )); then
          due=true
        fi
      fi
      ;;
  esac

  if $due; then
    echo "[$(date -u -Iseconds)] running backup for $slug (freq=$frequency)" >&2
    if /opt/wcn-cloud/scripts/backup-supabase.sh --slug "$slug"; then
      psql "$OPS_DB_URL" -c "UPDATE backup_policies SET last_run_at = now() WHERE customer_slug = '$slug'" >/dev/null
      echo "[$(date -u -Iseconds)] $slug: ok" >&2
    else
      echo "[$(date -u -Iseconds)] $slug: FAILED" >&2
    fi
  fi
done

# Retention: prune backups older than policy's retention_days
psql "$OPS_DB_URL" -t -A -F'|' -c "
  SELECT customer_slug, retention_days FROM backup_policies WHERE enabled = true
" | while IFS='|' read -r slug days; do
  [[ -z "$slug" || -z "$days" ]] && continue
  cutoff=$(date -u -d "$days days ago" -Iseconds)
  rclone delete --quiet --min-age "${days}d" "b2:wcn-cloud-backups/${slug}/postgres/" 2>/dev/null || true
  psql "$OPS_DB_URL" -c "
    UPDATE backups SET status = 'pruned'
    WHERE customer_slug = '$slug' AND status = 'succeeded' AND finished_at < '$cutoff'
  " >/dev/null
done
