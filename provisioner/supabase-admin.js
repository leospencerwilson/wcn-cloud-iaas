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
const BUCKET_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const ROOT_DOMAIN = process.env.ROOT_DOMAIN || "western-communication.com";

async function vmBySlug(slug) {
  return db.oneJson(
    `SELECT row_to_json(t) FROM (SELECT customer_slug, host(ip)::text AS ip FROM vms WHERE customer_slug = $1) t`,
    [slug],
  );
}

/* ── Service-role key cache & Kong proxy ──────────────────────────────
 * The customer's SERVICE_ROLE_KEY is in /etc/wcn-cloud/supabase.env on
 * the VM, root:root mode 0600. ops has passwordless sudo. We SSH-cat
 * once per slug and cache the result in memory. Restart wcn-provisioner
 * to invalidate.
 */
const serviceRoleCache = new Map(); // slug -> key

function sshCat(vmIp, remotePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "ssh",
      [
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=10",
        "-o", "StrictHostKeyChecking=accept-new",
        `ops@${vmIp}`,
        "sudo", "cat", remotePath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "", stderr = "";
    proc.stdout.on("data", (c) => (stdout += c));
    proc.stderr.on("data", (c) => (stderr += c));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(stderr.trim() || `ssh cat failed (${code})`));
      resolve(stdout);
    });
  });
}

async function getServiceRoleKey(slug) {
  if (serviceRoleCache.has(slug)) return serviceRoleCache.get(slug);
  const vm = await vmBySlug(slug);
  if (!vm) throw Object.assign(new Error("vm not found"), { status: 404 });
  const content = await sshCat(vm.ip, "/etc/wcn-cloud/supabase.env");
  const m = /^SERVICE_ROLE_KEY=(\S+)\s*$/m.exec(content);
  if (!m) throw Object.assign(new Error("SERVICE_ROLE_KEY not found in supabase.env"), { status: 500 });
  serviceRoleCache.set(slug, m[1]);
  return m[1];
}

/* Call Kong on the customer VM via its public api-<slug> hostname.
 * Returns { status, body } where body is parsed JSON (or raw text). */
async function kongCall(slug, path, { method = "GET", body, extraHeaders = {} } = {}) {
  if (!SLUG_RE.test(slug)) throw Object.assign(new Error("invalid slug"), { status: 400 });
  const key = await getServiceRoleKey(slug);
  const url = `https://api-${slug}.${ROOT_DOMAIN}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": body ? "application/json" : undefined,
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = text;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* leave as text */ }
  return { status: res.status, body: parsed };
}

/* Run a parameterless statement via psql (CREATE POLICY / DROP POLICY).
 * Caller is responsible for SQL injection safety — only call with
 * validated/identifier-quoted input. */
function runStatement(ip, sql, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const eof = `WCN_SBX_${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
    const script = `
set -e
CONT=$(docker ps --format '{{.Names}}' | grep '^supabase-db' | head -1)
if [ -z "$CONT" ]; then echo 'no supabase-db container' >&2; exit 2; fi
docker exec -i "$CONT" psql -U postgres -d postgres -X -v ON_ERROR_STOP=1 <<'${eof}'
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
      reject(Object.assign(new Error("statement timeout"), { status: 504 }));
    }, timeoutMs);
    proc.stdout.on("data", (c) => (stdout += c));
    proc.stderr.on("data", (c) => (stderr += c));
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(Object.assign(
        new Error(stderr.trim().split(/\r?\n/).slice(-3).join("\n") || "psql failed"),
        { status: 400 },
      ));
      resolve(stdout);
    });
    proc.stdin.write(script);
    proc.stdin.end();
  });
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
           coalesce((SELECT sum((metadata->>'size')::bigint) FROM storage.objects WHERE bucket_id = b.id), 0) AS total_bytes
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
  const sql = `SELECT coalesce(json_agg(row_to_json(p) ORDER BY p.schemaname, p.tablename, p.name), '[]'::json) FROM (
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
  // Edge Functions in OSS Supabase live on disk in the edge-runtime
  // container's volume (one folder per function), not in the database.
  // There's no fully-reliable way to enumerate them from SQL — the
  // supabase_functions schema only holds Coolify's internal hooks/
  // migrations metadata, which we deliberately exclude here. Until we
  // add a filesystem-listing endpoint, return empty and let the UI
  // point the user at Studio for deploys.
  void slug;
  void vm;
  try {
    json(res, 200, {
      functions: [],
      runtime_note: "Edge Functions are stored on the customer VM's edge-runtime volume, not in the database. Deploy via the Supabase CLI or the embedded Studio; runtime listing endpoint coming in a follow-up.",
    });
  } catch (e) {
    bad(res, e.status || 500, e.message, "psql_error");
  }
}

/* ─────────────────── MUTATIONS ─────────────────────────────────────
 * Auth + storage mutations go through Kong with the customer's
 * service-role key (not raw SQL — Supabase has hooks/triggers/audit
 * we'd skip). Policies go through SQL because pg_policies is just
 * Postgres + CREATE POLICY / DROP POLICY.
 */

/* POST /vms/{slug}/supabase/auth/users  { email, password?, phone?, user_metadata?, email_confirm? } */
async function authCreateUser(req, res, { slug, body }) {
  const email = body && body.email ? String(body.email).trim() : "";
  if (!email && !body.phone) return bad(res, 400, "email or phone required", "missing_identifier");
  const payload = {
    email: email || undefined,
    phone: body.phone || undefined,
    password: body.password || undefined,
    email_confirm: body.email_confirm !== false, // default true so manual creates are usable
    phone_confirm: body.phone_confirm === true,
    user_metadata: body.user_metadata || undefined,
    app_metadata: body.app_metadata || undefined,
  };
  try {
    const r = await kongCall(slug, "/auth/v1/admin/users", { method: "POST", body: payload });
    if (r.status >= 400) return json(res, r.status, r.body);
    json(res, 201, r.body);
  } catch (e) {
    bad(res, e.status || 500, e.message, "kong_error");
  }
}

/* PATCH /vms/{slug}/supabase/auth/users/{id}
 * Body: any of { email, password, ban_duration ("none"|"24h"|"7d"|"permanent"), user_metadata, app_metadata, role } */
async function authUpdateUser(req, res, { slug, params, body }) {
  const id = params.id;
  if (!/^[0-9a-f-]{36}$/.test(id)) return bad(res, 400, "invalid user id", "invalid_id");

  const patch = {};
  if (body.email)         patch.email = body.email;
  if (body.password)      patch.password = body.password;
  if (body.user_metadata) patch.user_metadata = body.user_metadata;
  if (body.app_metadata)  patch.app_metadata = body.app_metadata;
  if (body.role)          patch.role = body.role;
  if (body.ban_duration)  patch.ban_duration = body.ban_duration;
  if (Object.keys(patch).length === 0) return bad(res, 400, "no fields to update", "empty_patch");

  try {
    const r = await kongCall(slug, `/auth/v1/admin/users/${id}`, { method: "PUT", body: patch });
    if (r.status >= 400) return json(res, r.status, r.body);
    json(res, 200, r.body);
  } catch (e) {
    bad(res, e.status || 500, e.message, "kong_error");
  }
}

/* DELETE /vms/{slug}/supabase/auth/users/{id} */
async function authDeleteUser(req, res, { slug, params }) {
  const id = params.id;
  if (!/^[0-9a-f-]{36}$/.test(id)) return bad(res, 400, "invalid user id", "invalid_id");
  try {
    const r = await kongCall(slug, `/auth/v1/admin/users/${id}`, { method: "DELETE" });
    if (r.status >= 400) return json(res, r.status, r.body);
    json(res, 200, { ok: true });
  } catch (e) {
    bad(res, e.status || 500, e.message, "kong_error");
  }
}

/* POST /vms/{slug}/supabase/storage/buckets  { name, public?, file_size_limit?, allowed_mime_types? } */
async function storageCreateBucket(req, res, { slug, body }) {
  const name = body && body.name ? String(body.name).trim() : "";
  if (!BUCKET_RE.test(name)) return bad(res, 400, "invalid bucket name (lowercase, [a-z0-9._-], 1–63 chars)", "invalid_bucket_name");
  const payload = {
    id: name,
    name,
    public: body.public === true,
    file_size_limit: typeof body.file_size_limit === "number" ? body.file_size_limit : null,
    allowed_mime_types: Array.isArray(body.allowed_mime_types) ? body.allowed_mime_types : null,
  };
  try {
    const r = await kongCall(slug, "/storage/v1/bucket", { method: "POST", body: payload });
    if (r.status >= 400) return json(res, r.status, r.body);
    json(res, 201, r.body);
  } catch (e) {
    bad(res, e.status || 500, e.message, "kong_error");
  }
}

/* DELETE /vms/{slug}/supabase/storage/buckets/{name} */
async function storageDeleteBucket(req, res, { slug, params }) {
  const name = params.name;
  if (!BUCKET_RE.test(name)) return bad(res, 400, "invalid bucket name", "invalid_bucket_name");
  try {
    // Supabase requires emptying buckets first.
    await kongCall(slug, `/storage/v1/bucket/${encodeURIComponent(name)}/empty`, { method: "POST" });
    const r = await kongCall(slug, `/storage/v1/bucket/${encodeURIComponent(name)}`, { method: "DELETE" });
    if (r.status >= 400) return json(res, r.status, r.body);
    json(res, 200, { ok: true });
  } catch (e) {
    bad(res, e.status || 500, e.message, "kong_error");
  }
}

/* DELETE /vms/{slug}/supabase/storage/objects?bucket=&name= */
async function storageDeleteObject(req, res, { slug, query }) {
  const bucket = String(query.bucket || "");
  const name = String(query.name || "");
  if (!BUCKET_RE.test(bucket)) return bad(res, 400, "invalid bucket", "invalid_bucket_name");
  if (!name || name.length > 1024) return bad(res, 400, "missing or too-long name", "invalid_object_name");
  try {
    const r = await kongCall(slug, `/storage/v1/object/${encodeURIComponent(bucket)}/${encodeURIComponent(name)}`, { method: "DELETE" });
    if (r.status >= 400) return json(res, r.status, r.body);
    json(res, 200, { ok: true });
  } catch (e) {
    bad(res, e.status || 500, e.message, "kong_error");
  }
}

/* POST /vms/{slug}/supabase/policies
 * Body: { schema, table, name, cmd: "SELECT"|"INSERT"|"UPDATE"|"DELETE"|"ALL", roles?: ["public"|"authenticated"|...],
 *         using?: "<sql expr>", with_check?: "<sql expr>", permissive?: boolean (default true) } */
async function policyCreate(req, res, { slug, body }) {
  const vm = await vmBySlug(slug);
  if (!vm) return bad(res, 404, "vm not found", "not_found");
  const schema = String(body.schema || "");
  const table = String(body.table || "");
  const name = String(body.name || "");
  if (!IDENT.test(schema) || !IDENT.test(table) || !IDENT.test(name)) {
    return bad(res, 400, "schema, table, name must match [A-Za-z_][A-Za-z0-9_]{0,62}", "invalid_ident");
  }
  const cmd = String(body.cmd || "ALL").toUpperCase();
  if (!["SELECT","INSERT","UPDATE","DELETE","ALL"].includes(cmd)) {
    return bad(res, 400, "cmd must be SELECT, INSERT, UPDATE, DELETE, or ALL", "invalid_cmd");
  }
  const roles = Array.isArray(body.roles) && body.roles.length > 0
    ? body.roles.map((r) => String(r)).filter((r) => /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(r))
    : [];
  const permissive = body.permissive === false ? "RESTRICTIVE" : "PERMISSIVE";
  const usingExpr = body.using ? String(body.using) : "";
  const checkExpr = body.with_check ? String(body.with_check) : "";

  // Build SQL. Identifiers are quoted; expressions go through verbatim
  // (caller's responsibility — this is an admin op behind customer auth).
  const parts = [
    `CREATE POLICY "${name}" ON "${schema}"."${table}" AS ${permissive} FOR ${cmd}`,
  ];
  if (roles.length > 0) parts.push(`TO ${roles.map((r) => `"${r}"`).join(", ")}`);
  if (usingExpr)        parts.push(`USING (${usingExpr})`);
  if (checkExpr)        parts.push(`WITH CHECK (${checkExpr})`);
  const sql = parts.join("\n") + ";";

  try {
    await runStatement(vm.ip, sql);
    json(res, 201, { ok: true, sql });
  } catch (e) {
    bad(res, e.status || 400, e.message, "sql_error");
  }
}

/* DELETE /vms/{slug}/supabase/policies?schema=&table=&name= */
async function policyDelete(req, res, { slug, query }) {
  const vm = await vmBySlug(slug);
  if (!vm) return bad(res, 404, "vm not found", "not_found");
  const schema = String(query.schema || "");
  const table = String(query.table || "");
  const name = String(query.name || "");
  if (!IDENT.test(schema) || !IDENT.test(table) || !IDENT.test(name)) {
    return bad(res, 400, "schema, table, name must match identifier rules", "invalid_ident");
  }
  const sql = `DROP POLICY IF EXISTS "${name}" ON "${schema}"."${table}";`;
  try {
    await runStatement(vm.ip, sql);
    json(res, 200, { ok: true });
  } catch (e) {
    bad(res, e.status || 400, e.message, "sql_error");
  }
}

module.exports = {
  rows,
  authUsers,
  authCreateUser,
  authUpdateUser,
  authDeleteUser,
  storageBuckets,
  storageObjects,
  storageCreateBucket,
  storageDeleteBucket,
  storageDeleteObject,
  policies,
  policyCreate,
  policyDelete,
  realtime,
  functions,
};
