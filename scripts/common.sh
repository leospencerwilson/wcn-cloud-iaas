#!/usr/bin/env bash
# Shared helpers for all IaaS scripts.
# Source this from any script: `source "$(dirname "$0")/common.sh"`

set -euo pipefail
IFS=$'\n\t'

# ── colours ────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YEL=$'\033[33m'
  C_BLU=$'\033[34m'; C_DIM=$'\033[2m';  C_RST=$'\033[0m'
else
  C_RED= C_GRN= C_YEL= C_BLU= C_DIM= C_RST=
fi

# ── ssh/scp wrappers ───────────────────────────────────────────────────
# Trusted private subnet (10.10.x.x). Accept new host keys on first contact,
# but still reject if a known key changes.
SSH_OPTS=( -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 )
pssh() { ssh "${SSH_OPTS[@]}" "$@"; }
pscp() { scp "${SSH_OPTS[@]}" "$@"; }

log()   { printf '%s[%s]%s %s\n' "$C_DIM" "$(date -u +%H:%M:%S)" "$C_RST" "$*" >&2; }
info()  { printf '%s[INFO]%s  %s\n' "$C_BLU" "$C_RST" "$*" >&2; }
ok()    { printf '%s[ OK ]%s  %s\n' "$C_GRN" "$C_RST" "$*" >&2; }
warn()  { printf '%s[WARN]%s  %s\n' "$C_YEL" "$C_RST" "$*" >&2; }
err()   { printf '%s[ERR ]%s  %s\n' "$C_RED" "$C_RST" "$*" >&2; }
die()   { err "$*"; exit 1; }

# ── env validation ─────────────────────────────────────────────────────
require_env() {
  local missing=()
  for v in "$@"; do
    if [[ -z "${!v:-}" ]]; then missing+=("$v"); fi
  done
  if (( ${#missing[@]} > 0 )); then
    die "Missing required env vars: ${missing[*]}"
  fi
}

require_cmd() {
  local missing=()
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || missing+=("$c")
  done
  if (( ${#missing[@]} > 0 )); then
    die "Missing required commands: ${missing[*]}"
  fi
}

# ── slug + email validation ────────────────────────────────────────────
validate_slug() {
  local slug="$1"
  [[ "$slug" =~ ^[a-z][a-z0-9-]{2,19}$ ]] \
    || die "Slug '$slug' is invalid. Must match [a-z][a-z0-9-]{2,19}."

  local reserved_file
  reserved_file="$(dirname "${BASH_SOURCE[0]}")/../configs/reserved-slugs.txt"
  if [[ -f "$reserved_file" ]]; then
    if grep -qE "^${slug}$" <(grep -vE '^\s*(#|$)' "$reserved_file"); then
      die "Slug '$slug' is reserved. Edit configs/reserved-slugs.txt to change."
    fi
  fi
}

# Check ops DB for an existing customer with this slug.
# Returns 0 if available, 1 if taken.
slug_available() {
  local slug="$1"
  local count
  count=$(ops_db -c "SELECT count(*) FROM customers WHERE slug='${slug}';")
  [[ "$count" == "0" ]]
}

validate_email() {
  local email="$1"
  [[ "$email" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] \
    || die "Email '$email' is invalid."
}

validate_tier() {
  local tier="$1"
  case "$tier" in
    site|site-db|pro) ;;
    *) die "Tier '$tier' is invalid. Must be one of: site, site-db, pro." ;;
  esac
}

# ── Cloudflare API helper ──────────────────────────────────────────────
cf_api() {
  local method="$1"; shift
  local path="$1"; shift
  local body="${1:-}"
  local args=( -sS -X "$method" -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" )
  [[ -n "$body" ]] && args+=( -d "$body" )
  curl "${args[@]}" "https://api.cloudflare.com/client/v4${path}"
}

cf_api_ok() {
  local response="$1"
  [[ "$(jq -r '.success' <<<"$response")" == "true" ]]
}

# ── Proxmox API helper ─────────────────────────────────────────────────
pve_api() {
  local method="$1"; shift
  local path="$1"; shift
  local body="${1:-}"
  local args=( -sS -k -X "$method" -H "Authorization: PVEAPIToken=$PROXMOX_API_TOKEN" )
  [[ -n "$body" ]] && args+=( --data-urlencode "$body" )
  curl "${args[@]}" "https://${PROXMOX_HOST}:8006/api2/json${path}"
}

# ── ops DB helper ──────────────────────────────────────────────────────
ops_db() {
  psql "$OPS_DB_URL" --no-psqlrc -At -v ON_ERROR_STOP=1 "$@"
}

ops_db_audit() {
  local actor="${USER:-unknown}"
  local action="$1"
  local slug="$2"
  local details="$3"
  ops_db -c "INSERT INTO audit_log (actor, action, slug, details) VALUES ('$actor', '$action', '$slug', \$\$$details\$\$);"
}

# ── retry helper ───────────────────────────────────────────────────────
retry() {
  local max="$1"; shift
  local delay="$1"; shift
  local i=1
  while (( i <= max )); do
    if "$@"; then return 0; fi
    warn "Attempt $i/$max failed; retrying in ${delay}s"
    sleep "$delay"
    i=$((i + 1))
  done
  err "All $max attempts failed: $*"
  return 1
}
