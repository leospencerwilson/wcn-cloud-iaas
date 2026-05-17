#!/usr/bin/env bash
# Render the customer.env file from arguments. Output to stdout.
#
# Usage:
#   render-customer-env.sh \
#     --slug acme --tier pro --name "Acme Ltd" \
#     --email admin@acme.com --domain acme.com \
#     --tunnel-id <uuid> --brand-colour "#ff5500"

source "$(dirname "$0")/common.sh"

# Parse args
SLUG=""; TIER=""; NAME=""; EMAIL=""; DOMAIN=""; TUNNEL_ID=""; BRAND_COLOUR="#3b82f6"; IP=""

while (( $# > 0 )); do
  case "$1" in
    --slug)         SLUG="$2"; shift 2;;
    --tier)         TIER="$2"; shift 2;;
    --name)         NAME="$2"; shift 2;;
    --email)        EMAIL="$2"; shift 2;;
    --domain)       DOMAIN="$2"; shift 2;;
    --tunnel-id)    TUNNEL_ID="$2"; shift 2;;
    --brand-colour) BRAND_COLOUR="$2"; shift 2;;
    --ip)           IP="$2"; shift 2;;
    *) die "Unknown arg: $1";;
  esac
done

for v in SLUG TIER NAME EMAIL TUNNEL_ID IP; do
  [[ -z "${!v}" ]] && die "Missing --${v,,}"
done
# Domain is optional — custom domains are added later via add-custom-domain.sh.

case "$TIER" in
  site)    SUPABASE_PRESET="none";  COOLIFY_MEM="2g";;
  site-db) SUPABASE_PRESET="small"; COOLIFY_MEM="3g";;
  pro)     SUPABASE_PRESET="full";  COOLIFY_MEM="6g";;
  *)       die "Unknown tier: $TIER";;
esac

cat <<EOF
# /etc/wcn-cloud/customer.env
# Rendered $(date -u +%FT%TZ) by $USER

# ─── identity ─────────────────────────────────────────
SLUG="${SLUG}"
NAME="${NAME}"
TIER="${TIER}"
ADMIN_EMAIL="${EMAIL}"
PRIMARY_DOMAIN="${DOMAIN}"

# ─── network ──────────────────────────────────────────
VM_IP="${IP}"
GATEWAY="10.10.31.1"
CONSOLE_HOSTNAME="${SLUG}.western-communication.com"

# ─── cloudflare ──────────────────────────────────────
CLOUDFLARED_TUNNEL_ID="${TUNNEL_ID}"
CLOUDFLARED_TUNNEL_NAME="wcn-cloud-${SLUG}"

# ─── supabase / coolify ───────────────────────────────
SUPABASE_PRESET="${SUPABASE_PRESET}"
COOLIFY_MEM_LIMIT="${COOLIFY_MEM}"

# ─── branding ─────────────────────────────────────────
BRAND_PRIMARY="${BRAND_COLOUR}"
BRAND_SECONDARY="#1f2937"
PRODUCT_NAME="WCN Cloud"

# ─── backups ──────────────────────────────────────────
BACKUP_PREFIX="${SLUG}/postgres"
BACKUP_RETAIN_DAYS="30"

# ─── ops contacts ─────────────────────────────────────
OPS_CONTACT_EMAIL="cloud-support@western-communication.com"
EOF
