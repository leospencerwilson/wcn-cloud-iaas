#!/usr/bin/env bash
# Restore a customer's Supabase Postgres from a B2 backup.
# Destructive — drops and re-creates databases.
#
# Usage:
#   restore-customer.sh --slug acme --backup 20260507T030000Z
#   restore-customer.sh --slug acme --latest

source "$(dirname "$0")/common.sh"
require_env B2_KEY_ID B2_APP_KEY OPS_DB_URL
require_cmd rclone ssh psql

SLUG=""; BACKUP=""; LATEST=false; FORCE=false
while (( $# > 0 )); do
  case "$1" in
    --slug)   SLUG="$2"; shift 2;;
    --backup) BACKUP="$2"; shift 2;;
    --latest) LATEST=true; shift;;
    --force)  FORCE=true; shift;;
    --help|-h) sed -n '2,11p' "$0"; exit 0;;
    *) die "Unknown arg: $1";;
  esac
done
[[ -z "$SLUG" ]] && die "Missing --slug"
validate_slug "$SLUG"

ip=$(ops_db -c "SELECT ip FROM vms WHERE customer_slug='$SLUG' AND status='active'")
[[ -n "$ip" ]] || die "No active VM for slug '$SLUG'"

# Resolve which backup file we want.
if $LATEST; then
  BACKUP=$(rclone ls "b2:wcn-cloud-backups/${SLUG}/postgres/" \
    | awk '{print $2}' | sort | tail -n1 | sed -E 's/.*-([0-9TZ]+)\.sql\.gz/\1/')
  [[ -z "$BACKUP" ]] && die "No backups found for $SLUG"
fi
[[ -z "$BACKUP" ]] && die "Specify --backup <ts> or --latest"

remote="b2:wcn-cloud-backups/${SLUG}/postgres/customer-${SLUG}-${BACKUP}.sql.gz"
local="/tmp/restore-${SLUG}-${BACKUP}.sql.gz"

info "Will restore $remote → ${ip}'s Supabase Postgres"
warn "This will DROP all existing databases on the customer VM and replace them."

if ! $FORCE; then
  read -rp "Type the slug '${SLUG}' to confirm: " c
  [[ "$c" == "$SLUG" ]] || die "Confirmation didn't match. Aborted."
fi

ops_db_audit "restore-start" "$SLUG" "backup=$BACKUP"

info "[1/4] Downloading from B2..."
rclone copyto "$remote" "$local"
[[ -f "$local" ]] || die "Download failed"
ok "  $(du -h "$local" | cut -f1)"

info "[2/4] Uploading to VM..."
scp -q "$local" "ops@${ip}:/tmp/"
ok

info "[3/4] Stopping app containers (Coolify-managed) but keeping Postgres up..."
ssh ops@"$ip" '
  for c in $(docker ps -q --filter "label=coolify.managed" --filter "label!=coolify.type=database"); do
    docker stop "$c"
  done
'

info "[4/4] Restoring (this may take a few minutes for large dumps)..."
ssh ops@"$ip" "
  set -e
  PG=\$(docker ps -q -f name=supabase-db)
  gunzip < /tmp/$(basename "$local") | docker exec -i \$PG psql -U postgres
  rm /tmp/$(basename "$local")
"

# Restart the apps.
ssh ops@"$ip" '
  for c in $(docker ps -aq --filter "label=coolify.managed" --filter "status=exited"); do
    docker start "$c"
  done
'

rm -f "$local"
ops_db_audit "restore-done" "$SLUG" "backup=$BACKUP"
ok "Restore complete"
