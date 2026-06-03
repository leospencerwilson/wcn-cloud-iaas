#!/usr/bin/env bash
# Render customer.env OR supabase.env from arguments. Output to stdout.
#
# Usage:
#   render-customer-env.sh [--target customer|supabase] \
#     --slug acme --tier pro --name "Acme Ltd" \
#     --email admin@acme.com --domain acme.com \
#     --tunnel-id <uuid> --brand-colour "#ff5500"
#
# --target customer (default): emits /etc/wcn-cloud/customer.env content.
# --target supabase:           emits /etc/wcn-cloud/supabase.env content (with freshly
#                              generated secrets+JWT pair) AND writes the postgres
#                              password back to ops_db.vms.db_password for the slug.

source "$(dirname "$0")/common.sh"

# Parse args
SLUG=""; TIER=""; NAME=""; EMAIL=""; DOMAIN=""; TUNNEL_ID=""; BRAND_COLOUR="#3b82f6"; IP=""
TARGET="customer"

while (( $# > 0 )); do
  case "$1" in
    --target)       TARGET="$2"; shift 2;;
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

[[ "$TARGET" == "customer" || "$TARGET" == "supabase" ]] || die "--target must be 'customer' or 'supabase'"
for v in SLUG TIER NAME EMAIL TUNNEL_ID IP; do
  [[ -n "${!v}" ]] || die "Missing --${v,,}"
done
# Domain is optional — custom domains are added later via add-custom-domain.sh.

case "$TIER" in
  site)    SUPABASE_PRESET="none";  COOLIFY_MEM="2g";;
  site-db) SUPABASE_PRESET="small"; COOLIFY_MEM="3g";;
  pro)     SUPABASE_PRESET="full";  COOLIFY_MEM="6g";;
  *)       die "Unknown tier: $TIER";;
esac

CONSOLE_HOSTNAME="${SLUG}.western-communication.com"

# ── secret generation helpers ─────────────────────────────────────────
# Fixed-length hex (use when the consumer requires an exact length, e.g. AES keys)
rand_hex()  { openssl rand -hex "$1"; }                          # arg = bytes; output = 2*N hex chars
# Variable-length b64 (use for general-purpose secrets; trims env-unsafe chars)
rand_b64() {
  local bytes=$1 maxchars=${2:-}
  local out
  out=$(openssl rand -base64 "$bytes" | tr -d '\n=/+')
  if [[ -n "$maxchars" ]]; then out="${out:0:$maxchars}"; fi
  printf '%s' "$out"
}

# Supabase HS256 JWT signer: $1 = JWT_SECRET, $2 = role (anon|service_role)
b64url() { openssl base64 -e -A | tr '/+' '_-' | tr -d '='; }
make_supabase_jwt() {
  local secret="$1" role="$2"
  local header='{"alg":"HS256","typ":"JWT"}'
  local iat exp
  iat=$(date -u +%s)
  exp=$(( iat + 10*365*86400 ))   # 10-year expiry
  local payload="{\"role\":\"${role}\",\"iss\":\"supabase\",\"iat\":${iat},\"exp\":${exp}}"
  local h p sig
  h=$(printf '%s' "$header"  | b64url)
  p=$(printf '%s' "$payload" | b64url)
  sig=$(printf '%s.%s' "$h" "$p" | openssl dgst -sha256 -hmac "$secret" -binary | b64url)
  printf '%s.%s.%s' "$h" "$p" "$sig"
}

# ── supabase target ───────────────────────────────────────────────────
if [[ "$TARGET" == "supabase" ]]; then
  # Generate all per-customer Supabase secrets
  JWT_SECRET=$(rand_b64 48 40)
  POSTGRES_PASSWORD=$(rand_b64 36 32)
  DASHBOARD_PASSWORD=$(rand_b64 24 20)
  SECRET_KEY_BASE=$(rand_hex 32)               # 64 hex chars, used by Phoenix
  VAULT_ENC_KEY=$(rand_hex 16)                 # MUST be exactly 32 chars for AES-256-GCM (supavisor)
  PG_META_CRYPTO_KEY=$(rand_b64 48 40)
  LOGFLARE_PUBLIC_ACCESS_TOKEN=$(rand_b64 40 40)
  LOGFLARE_PRIVATE_ACCESS_TOKEN=$(rand_b64 40 40)
  ANON_KEY=$(make_supabase_jwt "$JWT_SECRET" "anon")
  SERVICE_ROLE_KEY=$(make_supabase_jwt "$JWT_SECRET" "service_role")

  # Store the db_password in ops_db so backup/restore tooling has it
  ops_db -c "UPDATE vms SET db_password='${POSTGRES_PASSWORD}' WHERE customer_slug='${SLUG}'" >/dev/null

  cat <<EOF
# /etc/wcn-cloud/supabase.env — generated $(date -u +%FT%TZ) for ${SLUG}
# DO NOT EDIT BY HAND. Re-generated on every (re-)provision. 0600 root:root.

POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
JWT_SECRET=${JWT_SECRET}
ANON_KEY=${ANON_KEY}
SERVICE_ROLE_KEY=${SERVICE_ROLE_KEY}

SUPABASE_PUBLISHABLE_KEY=
SUPABASE_SECRET_KEY=
JWT_KEYS=
JWT_JWKS=

DASHBOARD_USERNAME=supabase
DASHBOARD_PASSWORD=${DASHBOARD_PASSWORD}

SECRET_KEY_BASE=${SECRET_KEY_BASE}
VAULT_ENC_KEY=${VAULT_ENC_KEY}
PG_META_CRYPTO_KEY=${PG_META_CRYPTO_KEY}
LOGFLARE_PUBLIC_ACCESS_TOKEN=${LOGFLARE_PUBLIC_ACCESS_TOKEN}
LOGFLARE_PRIVATE_ACCESS_TOKEN=${LOGFLARE_PRIVATE_ACCESS_TOKEN}

S3_PROTOCOL_ACCESS_KEY_ID=625729a08b95bf1b7ff351a663f3a23c
S3_PROTOCOL_ACCESS_KEY_SECRET=850181e4652dd023b7a98c58ae0d2d34bd487ee0cc3254aed6eda37307425907

SUPABASE_PUBLIC_URL=https://${CONSOLE_HOSTNAME}/api
API_EXTERNAL_URL=https://${CONSOLE_HOSTNAME}/api

POSTGRES_HOST=db
POSTGRES_DB=postgres
POSTGRES_PORT=5432

POOLER_PROXY_PORT_TRANSACTION=6543
POOLER_DEFAULT_POOL_SIZE=20
POOLER_MAX_CLIENT_CONN=100
POOLER_TENANT_ID=${SLUG}
POOLER_DB_POOL_SIZE=5

STUDIO_DEFAULT_ORGANIZATION=${NAME}
STUDIO_DEFAULT_PROJECT=${NAME}
OPENAI_API_KEY=

SITE_URL=https://${CONSOLE_HOSTNAME}
ADDITIONAL_REDIRECT_URLS=
JWT_EXPIRY=3600
DISABLE_SIGNUP=false
MAILER_URLPATHS_CONFIRMATION=/auth/v1/verify
MAILER_URLPATHS_INVITE=/auth/v1/verify
MAILER_URLPATHS_RECOVERY=/auth/v1/verify
MAILER_URLPATHS_EMAIL_CHANGE=/auth/v1/verify
ENABLE_EMAIL_SIGNUP=true
ENABLE_EMAIL_AUTOCONFIRM=false
SMTP_ADMIN_EMAIL=admin@example.com
SMTP_HOST=supabase-mail
SMTP_PORT=2500
SMTP_USER=fake_mail_user
SMTP_PASS=fake_mail_password
SMTP_SENDER_NAME=fake_sender
ENABLE_ANONYMOUS_USERS=false
ENABLE_PHONE_SIGNUP=true
ENABLE_PHONE_AUTOCONFIRM=true

GLOBAL_S3_BUCKET=stub
REGION=stub
MINIO_ROOT_USER=supa-storage
MINIO_ROOT_PASSWORD=secret1234
STORAGE_TENANT_ID=stub

FUNCTIONS_VERIFY_JWT=false

PGRST_DB_SCHEMAS=public,storage,graphql_public
PGRST_DB_MAX_ROWS=1000
PGRST_DB_EXTRA_SEARCH_PATH=public

DOCKER_SOCKET_LOCATION=/var/run/docker.sock
GOOGLE_PROJECT_ID=GOOGLE_PROJECT_ID
GOOGLE_PROJECT_NUMBER=GOOGLE_PROJECT_NUMBER

KONG_HTTP_PORT=8000
KONG_HTTPS_PORT=8443

ANON_KEY_ASYMMETRIC=
SERVICE_ROLE_KEY_ASYMMETRIC=

IMGPROXY_AUTO_WEBP=true
EOF
  exit 0
fi

# ── customer target (existing behaviour) ──────────────────────────────
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
CONSOLE_HOSTNAME="${CONSOLE_HOSTNAME}"

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
