// Supabase admin endpoints — proxy SQL queries against the customer's
// supabase-db Postgres via ssh+docker exec. Used by the customer console
// Supabase tab to show auth users / storage / policies / realtime /
// functions / arbitrary table rows.
//
// All queries are READ-ONLY. Mutations (create user, upload file, etc.)
// will land in follow-up commits — they need either Supabase's GoTrue
// admin API (auth) or storage-api (buckets) which require per-customer
// service-role key handling. SQL-level inserts for auth/storage are too
// fragile (GoTrue has hooks + RLS + audit) so we route those through the
// real Kong endpoints when we add write paths.

const { spawn } = require("child_process");
const db = require("./db");

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
function bad(res, code, err, error_code = "bad_request") {
  json(res, code, { error: err, code: error_code });
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

async function vmBySlug(slug) {
  return db.oneJson(
    `SELECT row_to_json(t) FROM (SELECT customer_slug, host(ip)::text AS ip FROM vms WHERE customer_slug = $1) t`,
    [slug],
  );
}

// SQL via ssh + docker exec supabase-db psql. Returns parsed JSON from the
// query (the query must `json_agg(...)` its result). Same pattern as
// dbquery.runPsql but kept independent for clarity.
function runJson(ip, sql, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const eof = `WCN_SB_${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
    const script = `
set -e
CONT=$(docker ps --format '{{.Names}}' | grep '^supabase-db' | head -1)
if [ -z "$CONT" ]; then echo 'no supabase-db container' >&2; exit 2; fi
docker exec -i "$CONT" psql -U postgres -d postgres -X -t -A -v ON_ERROR_STOP=1 <<'${eof}'
SET LOCAL statement_timeout = '15s';
${sql}
${eof}
`;
    const proc = spawn(
      "ssh",
      [
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=10",
        "-o", "StrictHostKeyChecking=accept-new",
        `ops@${ip}`,
        "sudo", "bash", "-s",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "", stderr = "";
    const timer = setTimeout(() => {
      try { proc.kill("SIGTERM"); } catch {}
      reject(Object.assign(new Error("query timeout"), { status: 504 }));
    }, timeoutMs);
    proc.stdout.on("data", (c) => (stdout += c));
    proc.stderr.on("data", (c) => (stderr += c));
    proc.on("error", (err) => { clearTimeout(timer); reject(err); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(Object.assign(
          new Error(stderr.trim().split(/\r?\n/).slice(-3).join("\n") || "psql failed"),
          { status: 500 },
        ));
      }
      const line = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .reverse()
        .find((l) => l.startsWith("[") || l.startsWith("{")) || "[]";
      try { resolve(JSON.parse(line)); }
      catch (e) { reject(Object.assign(new Error(`bad psql json: ${e.message}`), { status: 500 })); }
    });
    proc.stdin.write(script);
    proc.stdin.end();
  });
}

/* ── /vms/{slug}/db/rows?schema=&table=&limit=&offset= ─────────────── */
async function rows(req, res, { slug, query }) {
  const vm = await vmBySlug(slug);
  if (!vm) return bad(res, 404, "vm not found", "not_found");
  const schema = String(query.schema || "public");
  const table = String(query.table || "");
  if (!IDENT.test(schema) || !IDENT.test(table)) {
    return bad(res, 400, "invalid schema or table", "invalid_ident");
  }
  const limit = Math.min(parseInt(query.limit || "50", 10) || 50, 500);
  const offset = Math.max(parseInt(query.offset || "0", 10) || 0, 0);

  const sql = `SELECT json_build_object(
    'rows', coalesce((SELECT json_agg(row_to_json(r)) FROM (
      SELECT * FROM ${schema}.${table} LIMIT ${limit} OFFSET ${offset}
    ) r), '[]'::json),
    'total', (SELECT reltuples::bigint FROM pg_class WHERE oid = '${schema}.${table}'::regclass)
  );`;
  try {
    const data = await runJson(vm.ip, sql);
    json(res, 200, { ...data, limit, offset });
  } catch (e) {
    bad(res, e.status || 500, e.message, "psql_error");
  }
}

/* ── /vms/{slug}/supabase/auth/users?limit=&offset= ────────────────── */
async function authUsers(req, res, { slug, query }) {
  const vm = await vmBySlug(slug);
  if (!vm) return bad(res, 404, "vm not found", "not_found");
  const limit = Math.min(parseInt(query.limit || "50", 10) || 50, 500);
  const offset = Math.max(parseInt(query.offset || "0", 10) || 0, 0);
  const sql = `SELECT json_build_object(
    'users', coalesce((SELECT json_agg(row_to_json(u)) FROM (
      SELECT id, email, phone, role, created_at, last_sign_in_at,
             email_confirmed_at IS NOT NULL AS email_confirmed,
             phone_confirmed_at IS NOT NULL AS phone_confirmed,
             banned_until IS NOT NULL AND banned_until > now() AS banned,
             raw_user_meta_data, raw_app_meta_data
      FROM auth.users
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    ) u), '[]'::json),
    'total', (SELECT count(*) FROM auth.users)
  );`;
  try {
    const data = await runJson(vm.ip, sql);
    json(res, 200, { ...data, limit, offset });
  } catch (e) {
    bad(res, e.status || 500, e.message, "psql_error");
  }
}

/* ── /vms/{slug}/supabase/storage/buckets ──────────────────────────── */
async function storageBuckets(req, res, { slug }) {
  const vm = await vmBySlug(slug);
  if (!vm) return bad(res, 404, "vm not found", "not_found");
  const sql = `SELECT coalesce(json_agg(row_to_json(b) ORDER BY b.created_at), '[]'::json) FROM (
    SELECT id, name, public, file_size_limit, allowed_mime_types, created_at, updated_at,
           (SELECT count(*) FROM storage.objects WHERE bucket_id = b.id) AS object_count,
           (SELECT coalesce(sum(metadata->>'size')::bigint, 0) FROM storage.objects WHERE bucket_id = b.id) AS total_bytes
    FROM storage.buckets b
  ) b;`;
  try {
    const list = await runJson(vm.ip, sql);
    json(res, 200, list);
  } catch (e) {
    bad(res, e.status || 500, e.message, "psql_error");
  }
}

/* ── /vms/{slug}/supabase/storage/objects?bucket=&limit=&offset= ───── */
async function storageObjects(req, res, { slug, query }) {
  const vm = await vmBySlug(slug);
  if (!vm) return bad(res, 404, "vm not found", "not_found");
  const bucket = String(query.bucket || "");
  if (!bucket || bucket.length > 200) return bad(res, 400, "bucket required", "missing_bucket");
  const limit = Math.min(parseInt(query.limit || "100", 10) || 100, 1000);
  const offset = Math.max(parseInt(query.offset || "0", 10) || 0, 0);
  const escaped = bucket.replace(/'/g, "''");
  const sql = `SELECT json_build_object(
    'objects', coalesce((SELECT json_agg(row_to_json(o)) FROM (
      SELECT name, bucket_id,
        (metadata->>'size')::bigint AS size_bytes,
        metadata->>'mimetype' AS mime_type,
        created_at, updated_at, last_accessed_at
      FROM storage.objects
      WHERE bucket_id = '${escaped}'
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    ) o), '[]'::json),
    'total', (SELECT count(*) FROM storage.objects WHERE bucket_id = '${escaped}')
  );`;
  try {
    const data = await runJson(vm.ip, sql);
    json(res, 200, { ...data, limit, offset });
  } catch (e) {
    bad(res, e.status || 500, e.message, "psql_error");
  }
}

/* ── /vms/{slug}/supabase/policies ─────────────────────────────────── */
async function policies(req, res, { slug }) {
  const vm = await vmBySlug(slug);
  if (!vm) return bad(res, 404, "vm not found", "not_found");
  const sql = `SELECT coalesce(json_agg(row_to_json(p) ORDER BY p.schemaname, p.tablename, p.policyname), '[]'::json) FROM (
    SELECT schemaname, tablename, policyname AS name, permissive, roles, cmd, qual, with_check
    FROM pg_policies
    WHERE schemaname NOT IN ('pg_catalog','information_schema')
  ) p;`;
  try {
    json(res, 200, await runJson(vm.ip, sql));
  } catch (e) {
    bad(res, e.status || 500, e.message, "psql_error");
  }
}

/* ── /vms/{slug}/supabase/realtime ─────────────────────────────────── */
async function realtime(req, res, { slug }) {
  const vm = await vmBySlug(slug);
  if (!vm) return bad(res, 404, "vm not found", "not_found");
  const sql = `SELECT json_build_object(
    'publications', coalesce((SELECT json_agg(row_to_json(p)) FROM (
      SELECT pubname AS name, pubinsert AS replicates_inserts, pubupdate AS replicates_updates,
             pubdelete AS replicates_deletes, pubtruncate AS replicates_truncates,
             puballtables AS all_tables
      FROM pg_publication
      ORDER BY pubname
    ) p), '[]'::json),
    'replicated_tables', coalesce((SELECT json_agg(row_to_json(t)) FROM (
      SELECT pubname AS publication, schemaname AS schema, tablename AS table
      FROM pg_publication_tables
      WHERE schemaname NOT IN ('pg_catalog','information_schema')
      ORDER BY schemaname, tablename
    ) t), '[]'::json),
    'replication_slots', coalesce((SELECT json_agg(row_to_json(s)) FROM (
      SELECT slot_name, plugin, slot_type, active, restart_lsn::text
      FROM pg_replication_slots
    ) s), '[]'::json)
  );`;
  try {
    json(res, 200, await runJson(vm.ip, sql));
  } catch (e) {
    bad(res, e.status || 500, e.message, "psql_error");
  }
}

/* ── /vms/{slug}/supabase/functions ────────────────────────────────── */
async function functions(req, res, { slug }) {
  const vm = await vmBySlug(slug);
  if (!vm) return bad(res, 404, "vm not found", "not_found");
  // Coolify-managed Supabase uses an `edge-functions` container backed by
  // a volume `/data/coolify/services/.../volumes/functions`. Listing
  // depends on the deploy layout. As a first pass we report what the DB
  // knows — supabase_functions schema (if present) — and let follow-up
  // commits read the filesystem when we add deploy/upload.
  const sql = `SELECT coalesce(json_agg(row_to_json(f)), '[]'::json) FROM (
    SELECT n.nspname AS schema, c.relname AS name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'supabase_functions'
  ) f;`;
  try {
    const list = await runJson(vm.ip, sql);
    json(res, 200, { functions: list, runtime_note: "Edge functions deploy via Coolify volumes; this listing reflects supabase_functions schema only." });
  } catch (e) {
    bad(res, e.status || 500, e.message, "psql_error");
  }
}

module.exports = {
  rows,
  authUsers,
  storageBuckets,
  storageObjects,
  policies,
  realtime,
  functions,
};
