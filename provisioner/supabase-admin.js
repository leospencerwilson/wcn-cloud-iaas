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
  const headers = { apikey: key, authorization: `Bearer ${key}`, ...extraHeaders };
  if (body) headers["content-type"] = "application/json";
  const res = await fetch(url, {
    method,
    headers,
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

/* ── /vms/{slug}/db/rows?table=&limit=&offset= ─────────────────────── */
/* Locked to the public schema. */
async function rows(req, res, { slug, query }) {
  const vm = await vmBySlug(slug);
  if (!vm) return bad(res, 404, "vm not found", "not_found");
  const schema = "public";
  const table = String(query.table || "");
  if (!IDENT.test(table)) {
    return bad(res, 400, "invalid table", "invalid_ident");
  }
  const limit = Math.min(parseInt(query.limit || "50", 10) || 50, 500);
  const offset = Math.max(parseInt(query.offset || "0", 10) || 0, 0);

  const sql = `SELECT json_build_object(
    'rows', coalesce((SELECT json_agg(row_to_json(r)) FROM (
      SELECT * FROM "${schema}"."${table}" LIMIT ${limit} OFFSET ${offset}
    ) r), '[]'::json),
    'total', (SELECT count(*) FROM "${schema}"."${table}")
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
  const sql = `SELECT coalesce(json_agg(row_to_json(p) ORDER BY p.tablename, p.name), '[]'::json) FROM (
    SELECT schemaname, tablename, policyname AS name, permissive, roles, cmd, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
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
  // Locked to public schema regardless of what the body sends.
  const schema = "public";
  const table = String(body.table || "");
  const name = String(body.name || "");
  if (!IDENT.test(table) || !IDENT.test(name)) {
    return bad(res, 400, "table and name must match [A-Za-z_][A-Za-z0-9_]{0,62}", "invalid_ident");
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

/* DELETE /vms/{slug}/supabase/policies?table=&name= (schema locked to public) */
async function policyDelete(req, res, { slug, query }) {
  const vm = await vmBySlug(slug);
  if (!vm) return bad(res, 404, "vm not found", "not_found");
  const schema = "public";
  const table = String(query.table || "");
  const name = String(query.name || "");
  if (!IDENT.test(table) || !IDENT.test(name)) {
    return bad(res, 400, "table and name must match identifier rules", "invalid_ident");
  }
  const sql = `DROP POLICY IF EXISTS "${name}" ON "${schema}"."${table}";`;
  try {
    await runStatement(vm.ip, sql);
    json(res, 200, { ok: true });
  } catch (e) {
    bad(res, e.status || 400, e.message, "sql_error");
  }
}

/* ── Table Editor: CREATE TABLE / ALTER TABLE / INSERT / UPDATE / DELETE ──
 * Public-schema only. Identifiers (table/column names) are strictly
 * validated, then double-quoted in SQL so reserved words work. Values
 * for INSERT/UPDATE go through Postgres's jsonb_populate_record so the
 * DB itself does the type casting — we never hand-encode numerics /
 * booleans / JSON / dates.
 */

// Whitelist of accepted PG type strings for column creation. Includes
// the canonical names + the parametric variants (varchar(n) etc.). Add
// to this as needed.
const TYPE_RE = /^(int2|int4|int8|smallint|integer|bigint|float4|float8|real|double precision|numeric(\([0-9]+(,[0-9]+)?\))?|decimal(\([0-9]+(,[0-9]+)?\))?|money|text|varchar(\([0-9]+\))?|character varying(\([0-9]+\))?|char(\([0-9]+\))?|character(\([0-9]+\))?|citext|bool|boolean|uuid|date|time(\([0-9]+\))?|timetz|timestamp(\([0-9]+\))?|timestamptz|interval|json|jsonb|bytea|inet|cidr|macaddr|tsvector|tsquery)(\[\])?$/i;

const FK_ACTION = new Set(["NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"]);

function assertIdent(s, label) {
  if (!IDENT.test(String(s))) {
    const e = new Error(`invalid ${label}: must match [A-Za-z_][A-Za-z0-9_]{0,62}`);
    e.status = 400;
    throw e;
  }
}

function assertType(t) {
  if (!TYPE_RE.test(String(t))) {
    const e = new Error(`unsupported type: ${t}`);
    e.status = 400;
    throw e;
  }
}

// Build the per-column SQL fragment for CREATE TABLE / ADD COLUMN.
// Accepts { name, type, nullable, default, primary_key, unique, identity,
// check, comment, foreign_key: { ref_table, ref_column, on_delete, on_update } }.
function columnFragment(col) {
  assertIdent(col.name, "column name");
  assertType(col.type);
  const parts = [`"${col.name}" ${col.type}`];
  if (col.identity) {
    const mode = col.identity === "always" ? "ALWAYS" : "BY DEFAULT";
    parts.push(`GENERATED ${mode} AS IDENTITY`);
  } else if (col.default !== undefined && col.default !== "" && col.default !== null) {
    // Default may be an expression like `now()` or `gen_random_uuid()` or
    // a literal like `'hello'`. The frontend sends the raw SQL fragment.
    parts.push(`DEFAULT ${col.default}`);
  }
  if (col.nullable === false) parts.push("NOT NULL");
  if (col.unique) parts.push("UNIQUE");
  if (col.check && String(col.check).trim()) {
    parts.push(`CHECK (${col.check})`);
  }
  if (col.foreign_key) {
    const fk = col.foreign_key;
    assertIdent(fk.ref_table, "fk ref_table");
    assertIdent(fk.ref_column, "fk ref_column");
    const onDel = (fk.on_delete || "NO ACTION").toUpperCase();
    const onUpd = (fk.on_update || "NO ACTION").toUpperCase();
    if (!FK_ACTION.has(onDel)) {
      const e = new Error(`invalid on_delete: ${onDel}`); e.status = 400; throw e;
    }
    if (!FK_ACTION.has(onUpd)) {
      const e = new Error(`invalid on_update: ${onUpd}`); e.status = 400; throw e;
    }
    parts.push(`REFERENCES "public"."${fk.ref_table}"("${fk.ref_column}") ON DELETE ${onDel} ON UPDATE ${onUpd}`);
  }
  return parts.join(" ");
}

// POST /vms/{slug}/db/tables  { name, columns: [Column], comment? }
async function createTable(req, res, { slug, body }) {
  const vm = await vmBySlug(slug);
  if (!vm) return bad(res, 404, "vm not found", "not_found");
  try {
    assertIdent(body.name, "table name");
    const cols = Array.isArray(body.columns) ? body.columns : [];
    if (cols.length === 0) {
      return bad(res, 400, "at least one column required", "missing_columns");
    }
    const fragments = cols.map(columnFragment);
    const pks = cols.filter((c) => c.primary_key).map((c) => `"${c.name}"`);
    if (pks.length > 0) fragments.push(`PRIMARY KEY (${pks.join(", ")})`);
    const sql = [`CREATE TABLE "public"."${body.name}" (\n  ${fragments.join(",\n  ")}\n);`];
    if (body.comment) {
      const esc = String(body.comment).replace(/'/g, "''");
      sql.push(`COMMENT ON TABLE "public"."${body.name}" IS '${esc}';`);
    }
    for (const c of cols) {
      if (c.comment) {
        const esc = String(c.comment).replace(/'/g, "''");
        sql.push(`COMMENT ON COLUMN "public"."${body.name}"."${c.name}" IS '${esc}';`);
      }
    }
    await runStatement(vm.ip, sql.join("\n"));
    json(res, 201, { ok: true });
  } catch (e) {
    bad(res, e.status || 400, e.message, "sql_error");
  }
}

// DELETE /vms/{slug}/db/tables/{name}
async function dropTable(req, res, { slug, params }) {
  const vm = await vmBySlug(slug);
  if (!vm) return bad(res, 404, "vm not found", "not_found");
  try {
    assertIdent(params.name, "table name");
    await runStatement(vm.ip, `DROP TABLE "public"."${params.name}";`);
    json(res, 200, { ok: true });
  } catch (e) {
    bad(res, e.status || 400, e.message, "sql_error");
  }
}

// PATCH /vms/{slug}/db/tables/{name}  { new_name?, comment? }
async function alterTable(req, res, { slug, params, body }) {
  const vm = await vmBySlug(slug);
  if (!vm) return bad(res, 404, "vm not found", "not_found");
  try {
    assertIdent(params.name, "table name");
    const stmts = [];
    if (body.new_name) {
      assertIdent(body.new_name, "new table name");
      stmts.push(`ALTER TABLE "public"."${params.name}" RENAME TO "${body.new_name}";`);
    }
    if (body.comment !== undefined) {
      const target = body.new_name || params.name;
      const esc = String(body.comment).replace(/'/g, "''");
      stmts.push(`COMMENT ON TABLE "public"."${target}" IS '${esc}';`);
    }
    if (stmts.length === 0) return bad(res, 400, "no change requested", "empty_patch");
    await runStatement(vm.ip, stmts.join("\n"));
    json(res, 200, { ok: true });
  } catch (e) {
    bad(res, e.status || 400, e.message, "sql_error");
  }
}

// POST /vms/{slug}/db/tables/{table}/columns  Column body
async function addColumn(req, res, { slug, params, body }) {
  const vm = await vmBySlug(slug);
  if (!vm) return bad(res, 404, "vm not found", "not_found");
  try {
    assertIdent(params.table, "table name");
    const frag = columnFragment(body);
    const stmts = [`ALTER TABLE "public"."${params.table}" ADD COLUMN ${frag};`];
    if (body.primary_key) {
      // ALTER TABLE doesn't accept inline PRIMARY KEY in ADD COLUMN with
      // the constraint syntax we use — express it as a separate ALTER.
      stmts.push(`ALTER TABLE "public"."${params.table}" ADD CONSTRAINT "${params.table}_${body.name}_pkey" PRIMARY KEY ("${body.name}");`);
    }
    if (body.comment) {
      const esc = String(body.comment).replace(/'/g, "''");
      stmts.push(`COMMENT ON COLUMN "public"."${params.table}"."${body.name}" IS '${esc}';`);
    }
    await runStatement(vm.ip, stmts.join("\n"));
    json(res, 201, { ok: true });
  } catch (e) {
    bad(res, e.status || 400, e.message, "sql_error");
  }
}

// PATCH /vms/{slug}/db/tables/{table}/columns/{column}
// Body: { new_name?, type?, nullable?, default?, drop_default?, comment? }
async function alterColumn(req, res, { slug, params, body }) {
  const vm = await vmBySlug(slug);
  if (!vm) return bad(res, 404, "vm not found", "not_found");
  try {
    assertIdent(params.table, "table name");
    assertIdent(params.column, "column name");
    const tbl = `"public"."${params.table}"`;
    const col = `"${params.column}"`;
    const stmts = [];
    if (body.new_name) {
      assertIdent(body.new_name, "new column name");
      stmts.push(`ALTER TABLE ${tbl} RENAME COLUMN ${col} TO "${body.new_name}";`);
    }
    const finalName = body.new_name ? `"${body.new_name}"` : col;
    if (body.type) {
      assertType(body.type);
      const usingClause = body.type_using ? ` USING (${body.type_using})` : "";
      stmts.push(`ALTER TABLE ${tbl} ALTER COLUMN ${finalName} TYPE ${body.type}${usingClause};`);
    }
    if (body.nullable === true) {
      stmts.push(`ALTER TABLE ${tbl} ALTER COLUMN ${finalName} DROP NOT NULL;`);
    } else if (body.nullable === false) {
      stmts.push(`ALTER TABLE ${tbl} ALTER COLUMN ${finalName} SET NOT NULL;`);
    }
    if (body.drop_default) {
      stmts.push(`ALTER TABLE ${tbl} ALTER COLUMN ${finalName} DROP DEFAULT;`);
    } else if (body.default !== undefined && body.default !== "" && body.default !== null) {
      stmts.push(`ALTER TABLE ${tbl} ALTER COLUMN ${finalName} SET DEFAULT ${body.default};`);
    }
    if (body.comment !== undefined) {
      const esc = String(body.comment).replace(/'/g, "''");
      stmts.push(`COMMENT ON COLUMN ${tbl}.${finalName} IS '${esc}';`);
    }
    if (stmts.length === 0) return bad(res, 400, "no change requested", "empty_patch");
    await runStatement(vm.ip, stmts.join("\n"));
    json(res, 200, { ok: true });
  } catch (e) {
    bad(res, e.status || 400, e.message, "sql_error");
  }
}

// DELETE /vms/{slug}/db/tables/{table}/columns/{column}
async function dropColumn(req, res, { slug, params }) {
  const vm = await vmBySlug(slug);
  if (!vm) return bad(res, 404, "vm not found", "not_found");
  try {
    assertIdent(params.table, "table name");
    assertIdent(params.column, "column name");
    await runStatement(
      vm.ip,
      `ALTER TABLE "public"."${params.table}" DROP COLUMN "${params.column}";`,
    );
    json(res, 200, { ok: true });
  } catch (e) {
    bad(res, e.status || 400, e.message, "sql_error");
  }
}

// Dollar-quote-safe JSON literal for embedding in SQL via $tag$…$tag$.
function dollarQuoted(jsonStr) {
  // Pick a tag that doesn't collide with the payload.
  let tag = "wcn";
  while (jsonStr.includes(`$${tag}$`)) tag += "x";
  return { open: `$${tag}$`, close: `$${tag}$`, tag };
}

// POST /vms/{slug}/db/tables/{table}/rows  { values: {col: typed_val, ...} }
// Only the supplied columns are inserted; identity / DEFAULT columns
// the user omitted fire normally on the DB side.
async function insertRow(req, res, { slug, params, body }) {
  const vm = await vmBySlug(slug);
  if (!vm) return bad(res, 404, "vm not found", "not_found");
  try {
    assertIdent(params.table, "table name");
    const values = body.values || {};
    if (typeof values !== "object" || values == null) {
      return bad(res, 400, "values object required", "missing_values");
    }
    const keys = Object.keys(values);
    if (keys.length === 0) {
      // No user-provided columns — insert defaults for everything.
      await runStatement(vm.ip, `INSERT INTO "public"."${params.table}" DEFAULT VALUES;`);
      return json(res, 201, { ok: true });
    }
    keys.forEach((k) => assertIdent(k, "column"));
    const payload = JSON.stringify(values);
    const q = dollarQuoted(payload);
    const colList = keys.map((k) => `"${k}"`).join(", ");
    const sql = `INSERT INTO "public"."${params.table}" (${colList}) SELECT ${colList} FROM jsonb_populate_record(NULL::"public"."${params.table}", ${q.open}${payload}${q.close}::jsonb);`;
    await runStatement(vm.ip, sql);
    json(res, 201, { ok: true });
  } catch (e) {
    bad(res, e.status || 400, e.message, "sql_error");
  }
}

// PATCH /vms/{slug}/db/tables/{table}/rows
// Body: { pk: { col: val, ... }, values: { col: val, ... } }
async function updateRow(req, res, { slug, params, body }) {
  const vm = await vmBySlug(slug);
  if (!vm) return bad(res, 404, "vm not found", "not_found");
  try {
    assertIdent(params.table, "table name");
    const pk = body.pk || {};
    const values = body.values || {};
    const pkKeys = Object.keys(pk);
    const valKeys = Object.keys(values);
    if (pkKeys.length === 0) return bad(res, 400, "pk required", "missing_pk");
    if (valKeys.length === 0) return bad(res, 400, "values required", "missing_values");
    pkKeys.forEach((k) => assertIdent(k, "pk column"));
    valKeys.forEach((k) => assertIdent(k, "value column"));

    // Build the SET clause via jsonb_populate_record so types are correct.
    const valPayload = JSON.stringify(values);
    const pkPayload = JSON.stringify(pk);
    const qv = dollarQuoted(valPayload);
    const qp = dollarQuoted(pkPayload);
    const setCols = valKeys.map((k) => `"${k}" = nv."${k}"`).join(", ");
    const whereCols = pkKeys.map((k) => `"public"."${params.table}"."${k}" = pkv."${k}"`).join(" AND ");
    const sql = `
UPDATE "public"."${params.table}"
SET ${setCols}
FROM (SELECT * FROM jsonb_populate_record(NULL::"public"."${params.table}", ${qv.open}${valPayload}${qv.close}::jsonb)) nv,
     (SELECT * FROM jsonb_populate_record(NULL::"public"."${params.table}", ${qp.open}${pkPayload}${qp.close}::jsonb)) pkv
WHERE ${whereCols};`;
    await runStatement(vm.ip, sql);
    json(res, 200, { ok: true });
  } catch (e) {
    bad(res, e.status || 400, e.message, "sql_error");
  }
}

// DELETE /vms/{slug}/db/tables/{table}/rows  Body: { pk: { col: val, ... } }
async function deleteRow(req, res, { slug, params, body }) {
  const vm = await vmBySlug(slug);
  if (!vm) return bad(res, 404, "vm not found", "not_found");
  try {
    assertIdent(params.table, "table name");
    const pk = body.pk || {};
    const pkKeys = Object.keys(pk);
    if (pkKeys.length === 0) return bad(res, 400, "pk required", "missing_pk");
    pkKeys.forEach((k) => assertIdent(k, "pk column"));
    const payload = JSON.stringify(pk);
    const q = dollarQuoted(payload);
    const whereCols = pkKeys.map((k) => `"public"."${params.table}"."${k}" = pkv."${k}"`).join(" AND ");
    const sql = `
DELETE FROM "public"."${params.table}"
USING (SELECT * FROM jsonb_populate_record(NULL::"public"."${params.table}", ${q.open}${payload}${q.close}::jsonb)) pkv
WHERE ${whereCols};`;
    await runStatement(vm.ip, sql);
    json(res, 200, { ok: true });
  } catch (e) {
    bad(res, e.status || 400, e.message, "sql_error");
  }
}

// GET /vms/{slug}/db/tables/{table}/info — full column metadata + PK +
// indexes + comment, for the table editor to render the column form
// pre-filled. Locked to public.
async function tableInfo(req, res, { slug, params }) {
  const vm = await vmBySlug(slug);
  if (!vm) return bad(res, 404, "vm not found", "not_found");
  try {
    assertIdent(params.table, "table name");
    const sql = `SELECT json_build_object(
      'columns', coalesce((SELECT json_agg(row_to_json(c) ORDER BY c.ordinal_position) FROM (
        SELECT
          c.column_name AS name,
          c.data_type,
          c.udt_name,
          c.is_nullable = 'YES' AS nullable,
          c.column_default AS default,
          c.character_maximum_length,
          c.numeric_precision,
          c.numeric_scale,
          c.ordinal_position,
          col_description((quote_ident(c.table_schema) || '.' || quote_ident(c.table_name))::regclass, c.ordinal_position) AS comment,
          (c.is_identity = 'YES') AS identity,
          EXISTS (
            SELECT 1 FROM pg_index i
            JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
            WHERE i.indrelid = ('public.' || c.table_name)::regclass
              AND i.indisprimary
              AND a.attname = c.column_name
          ) AS primary_key
        FROM information_schema.columns c
        WHERE c.table_schema = 'public' AND c.table_name = '${params.table}'
      ) c), '[]'::json),
      'comment', (SELECT obj_description(('public.' || '${params.table}')::regclass)),
      'rls_enabled', (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || '${params.table}')::regclass)
    );`;
    const data = await runJson(vm.ip, sql);
    json(res, 200, data);
  } catch (e) {
    bad(res, e.status || 400, e.message, "sql_error");
  }
}

/* Run an arbitrary shell script on a customer VM via `ssh ops@<ip> sudo bash -s`.
 * Same pattern as runStatement but lets the caller compose its own commands.
 * Resolves with stdout; rejects with the last few stderr lines and a synthetic
 * `status` for HTTP propagation. */
function sshExec(ip, script, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
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
      reject(Object.assign(new Error("ssh timeout"), { status: 504 }));
    }, timeoutMs);
    proc.stdout.on("data", (c) => (stdout += c));
    proc.stderr.on("data", (c) => (stderr += c));
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(Object.assign(
        new Error(stderr.trim().split(/\r?\n/).slice(-5).join("\n") || `ssh exit ${code}`),
        { status: 400 },
      ));
      resolve(stdout);
    });
    proc.stdin.write(script);
    proc.stdin.end();
  });
}

const FN_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const FN_CODE_MAX = 200 * 1024;
const FN_DIR = "/opt/supabase-stack/volumes/functions";

function pickEofToken(haystack) {
  let t = `WCN_FN_${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  while (haystack.includes(t)) t = `WCN_FN_${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  return t;
}

/* POST /vms/{slug}/supabase/functions  { name, code }
 * Writes the supplied code to /opt/supabase-stack/volumes/functions/<name>/index.ts
 * on the customer VM. The edge-runtime container picks new functions up on
 * the next invocation — no restart needed. */
async function functionDeploy(req, res, { slug, body }) {
  const vm = await vmBySlug(slug);
  if (!vm) return bad(res, 404, "vm not found", "not_found");
  const name = String(body.name || "");
  const code = String(body.code || "");
  if (!FN_NAME_RE.test(name)) {
    return bad(res, 400, "invalid function name (a-z 0-9 _ -, must start with a letter)", "invalid_name");
  }
  if (!code.trim()) return bad(res, 400, "code required", "missing_code");
  if (code.length > FN_CODE_MAX) return bad(res, 413, `code exceeds ${FN_CODE_MAX} bytes`, "too_large");
  const eof = pickEofToken(code);
  const script = `set -e
mkdir -p ${FN_DIR}/${name}
cat > ${FN_DIR}/${name}/index.ts <<'${eof}'
${code}
${eof}
chown -R 1000:1000 ${FN_DIR}/${name}
chmod 644 ${FN_DIR}/${name}/index.ts
echo deployed=${name}`;
  try {
    await sshExec(vm.ip, script);
    json(res, 201, { ok: true, name });
  } catch (e) {
    bad(res, e.status || 502, e.message, "deploy_failed");
  }
}

/* DELETE /vms/{slug}/supabase/functions/{name}
 * Removes the function directory. Customer admin / main / hello are guarded. */
async function functionDelete(req, res, { slug, params }) {
  const vm = await vmBySlug(slug);
  if (!vm) return bad(res, 404, "vm not found", "not_found");
  const name = String(params.name || "");
  if (!FN_NAME_RE.test(name)) return bad(res, 400, "invalid name", "invalid_name");
  if (name === "main" || name === "_shared") {
    return bad(res, 409, "the 'main' router and '_shared' helpers cannot be deleted via the API", "reserved_function");
  }
  const script = `set -e
[ -d ${FN_DIR}/${name} ] || { echo not_found >&2; exit 4; }
rm -rf ${FN_DIR}/${name}
echo deleted=${name}`;
  try {
    await sshExec(vm.ip, script);
    json(res, 200, { ok: true });
  } catch (e) {
    if (e.message && e.message.includes("not_found")) {
      return bad(res, 404, "function not found", "not_found");
    }
    bad(res, e.status || 502, e.message, "delete_failed");
  }
}

/* GET /vms/{slug}/supabase/functions/deployed
 * Returns the list of function directories on disk with size + mtime. */
async function functionsListDeployed(req, res, { slug }) {
  const vm = await vmBySlug(slug);
  if (!vm) return bad(res, 404, "vm not found", "not_found");
  const script = `cd ${FN_DIR} 2>/dev/null && for d in */; do
  name=\${d%/}
  size=$(stat -c %s "$d/index.ts" 2>/dev/null || echo 0)
  mtime=$(stat -c %Y "$d/index.ts" 2>/dev/null || echo 0)
  printf '%s\\t%s\\t%s\\n' "$name" "$size" "$mtime"
done`;
  try {
    const out = await sshExec(vm.ip, script);
    const items = out.trim().split("\n").filter(Boolean).map((line) => {
      const [name, size, mtime] = line.split("\t");
      return {
        name,
        size_bytes: parseInt(size, 10) || 0,
        mtime: mtime && Number(mtime) > 0 ? new Date(parseInt(mtime, 10) * 1000).toISOString() : null,
      };
    });
    json(res, 200, items);
  } catch (e) {
    bad(res, e.status || 502, e.message, "list_failed");
  }
}

/* GET /vms/{slug}/supabase/functions/{name}/source
 * Returns the function's index.ts contents. */
async function functionSource(req, res, { slug, params }) {
  const vm = await vmBySlug(slug);
  if (!vm) return bad(res, 404, "vm not found", "not_found");
  const name = String(params.name || "");
  if (!FN_NAME_RE.test(name)) return bad(res, 400, "invalid name", "invalid_name");
  const script = `cat ${FN_DIR}/${name}/index.ts 2>/dev/null || { echo not_found >&2; exit 4; }`;
  try {
    const out = await sshExec(vm.ip, script);
    json(res, 200, { name, code: out });
  } catch (e) {
    if (e.message && e.message.includes("not_found")) {
      return bad(res, 404, "function not found", "not_found");
    }
    bad(res, e.status || 502, e.message, "read_failed");
  }
}

/* POST /vms/{slug}/supabase/storage/objects/upload?bucket=&path=
 * Streams the raw request body to Kong /storage/v1/object/{bucket}/{path}
 * with the service-role key + x-upsert: true. Body cap = 100 MiB v1 —
 * enforced here so a runaway upload can't blow up the provisioner. */
const UPLOAD_MAX_BYTES = 100 * 1024 * 1024;

async function storageUploadObject(req, res, { slug, query }) {
  const vm = await vmBySlug(slug);
  if (!vm) return bad(res, 404, "vm not found", "not_found");
  const bucket = String(query.bucket || "");
  const objPath = String(query.path || "");
  if (!bucket || !objPath) return bad(res, 400, "bucket and path required", "missing");
  if (!/^[a-z0-9][a-z0-9._-]{0,62}$/i.test(bucket)) return bad(res, 400, "invalid bucket", "invalid_bucket");
  if (objPath.length > 1024 || objPath.includes("..") || objPath.startsWith("/")) {
    return bad(res, 400, "invalid path", "invalid_path");
  }
  // Read request body up to the cap.
  const chunks = [];
  let total = 0;
  try {
    for await (const c of req) {
      total += c.length;
      if (total > UPLOAD_MAX_BYTES) return bad(res, 413, "upload exceeds 100 MiB cap", "too_large");
      chunks.push(c);
    }
  } catch (e) {
    return bad(res, 400, `body read failed: ${e.message}`, "body_read");
  }
  const body = Buffer.concat(chunks);
  const contentType = req.headers["content-type"] || "application/octet-stream";
  try {
    const key = await getServiceRoleKey(slug);
    const encodedPath = objPath.split("/").map(encodeURIComponent).join("/");
    const url = `https://api-${slug}.${ROOT_DOMAIN}/storage/v1/object/${encodeURIComponent(bucket)}/${encodedPath}`;
    const upstream = await fetch(url, {
      method: "POST",
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        "content-type": contentType,
        "x-upsert": "true",
      },
      body,
    });
    const text = await upstream.text();
    let parsed = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* keep as text */ }
    res.writeHead(upstream.status, { "content-type": "application/json" });
    res.end(typeof parsed === "string" ? JSON.stringify({ message: parsed }) : JSON.stringify(parsed));
  } catch (e) {
    bad(res, 502, e.message, "upstream_error");
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
  storageUploadObject,
  policies,
  policyCreate,
  policyDelete,
  realtime,
  functions,
  createTable,
  dropTable,
  alterTable,
  tableInfo,
  addColumn,
  alterColumn,
  dropColumn,
  insertRow,
  updateRow,
  deleteRow,
  functionDeploy,
  functionDelete,
  functionsListDeployed,
  functionSource,
};
