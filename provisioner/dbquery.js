// T-feature #17: Embedded DB GUI backend. Customers run SQL against
// their own Supabase Postgres. Executes via ssh ops@VM → docker exec
// supabase-db psql.

const { spawn } = require("child_process");
const db = require("./db");

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
function bad(res, code, err, error_code = "bad_request") {
  json(res, code, { error: err, code: error_code });
}

async function audit(req, action, slug, details = "") {
  try {
    await db.exec(
      `INSERT INTO audit_log (actor, action, slug, details) VALUES ($1, $2, $3, $4)`,
      [(req.headers["x-wcn-actor"] || "system").toString().slice(0, 120), action, slug, details],
    );
  } catch (e) { console.error("[dbquery] audit failed:", e.message); }
}

async function vmBySlug(slug) {
  return db.oneJson(
    `SELECT row_to_json(t) FROM (SELECT customer_slug, host(ip)::text AS ip FROM vms WHERE customer_slug = $1) t`,
    [slug],
  );
}

// Pipe a SQL script to `docker exec supabase-db psql` via ssh.
// The full bash command is sent over stdin to `sudo bash -s` on the
// remote, then bash pipes the SQL into psql via a randomised heredoc.
function runPsql(ip, sqlScript, { tuplesOnly = false, timeoutMs = 35000 } = {}) {
  return new Promise((resolve, reject) => {
    const psqlFlags = tuplesOnly ? "-t -A" : "";
    const eofMarker = `WCN_SQL_${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
    const bashScript = `
set -e
CONT=$(docker ps --format '{{.Names}}' | grep '^supabase-db' | head -1)
if [ -z "$CONT" ]; then echo 'no supabase-db container' >&2; exit 2; fi
docker exec -i "$CONT" psql -U postgres -d postgres -X -v ON_ERROR_STOP=1 ${psqlFlags} <<'${eofMarker}'
${sqlScript}
${eofMarker}
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
    proc.on("close", (code) => { clearTimeout(timer); resolve({ stdout, stderr, code }); });
    proc.stdin.write(bashScript);
    proc.stdin.end();
  });
}

// POST /vms/{slug}/db/query { sql, max_rows? }
async function query(req, res, { slug, body }) {
  const vm = await vmBySlug(slug);
  if (!vm) return bad(res, 404, "vm not found", "not_found");

  let sql = String((body && body.sql) || "").trim();
  if (!sql) return bad(res, 400, "sql required", "missing_sql");
  if (sql.length > 100000) return bad(res, 400, "sql too long (max 100KB)", "sql_too_long");
  sql = sql.replace(/;\s*$/, "");

  const maxRows = Math.min(parseInt((body && body.max_rows) || "1000", 10) || 1000, 5000);
  await audit(req, "db.query", slug, `len=${sql.length} max_rows=${maxRows}`);

  const firstWord = sql.trim().split(/\s+/, 1)[0].toUpperCase();
  const isQuery = ["SELECT", "WITH", "TABLE", "VALUES", "SHOW", "EXPLAIN"].includes(firstWord);

  const start = Date.now();
  const script = isQuery
    ? `SET LOCAL statement_timeout = '30s';\nWITH user_q AS (${sql})\nSELECT coalesce(json_agg(row_to_json(t)), '[]'::json) FROM (SELECT * FROM user_q LIMIT ${maxRows}) t;\n`
    : `SET LOCAL statement_timeout = '30s';\n${sql};\n`;

  let result;
  try {
    result = await runPsql(vm.ip, script, { tuplesOnly: isQuery });
  } catch (e) {
    return bad(res, e.status || 502, e.message, "ssh_error");
  }
  const duration_ms = Date.now() - start;

  if (result.code !== 0) {
    return json(res, 400, {
      error: result.stderr.trim().split(/\r?\n/).slice(-5).join("\n"),
      code: "sql_error",
      duration_ms,
    });
  }

  if (isQuery) {
    let rows = [];
    // psql echoes 'SET' on its own line before the JSON. Take the last
    // non-empty line that looks like JSON.
    const lines = result.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const jsonLine = lines.reverse().find((l) => l.startsWith("[") || l.startsWith("{")) || "[]";
    try { rows = JSON.parse(jsonLine); } catch {}
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    return json(res, 200, {
      statement_type: firstWord,
      rows,
      columns,
      row_count: rows.length,
      truncated: rows.length === maxRows,
      duration_ms,
    });
  }

  const last = result.stdout.trim().split(/\r?\n/).pop() || "";
  const m = /^(INSERT|UPDATE|DELETE)\s+\d*\s*(\d+)/.exec(last);
  return json(res, 200, {
    statement_type: firstWord,
    affected_rows: m ? parseInt(m[2], 10) : null,
    output: result.stdout.trim().slice(0, 4000),
    duration_ms,
  });
}

// GET /vms/{slug}/db/tables
async function tables(req, res, { slug }) {
  const vm = await vmBySlug(slug);
  if (!vm) return bad(res, 404, "vm not found", "not_found");
  const sql = `SELECT json_agg(row_to_json(t)) FROM (
       SELECT schemaname AS schema, tablename AS name,
         pg_total_relation_size(quote_ident(schemaname)||'.'||quote_ident(tablename))::bigint AS size_bytes,
         (SELECT reltuples::bigint FROM pg_class WHERE oid = (quote_ident(schemaname)||'.'||quote_ident(tablename))::regclass) AS estimated_rows
       FROM pg_tables
       WHERE schemaname NOT IN ('pg_catalog','information_schema','pg_toast')
       ORDER BY schemaname, tablename
     ) t;`;
  let result;
  try { result = await runPsql(vm.ip, sql, { tuplesOnly: true }); }
  catch (e) { return bad(res, e.status || 502, e.message, "ssh_error"); }
  if (result.code !== 0) return bad(res, 500, result.stderr.slice(0, 500), "psql_error");
  let rows = [];
  try { rows = JSON.parse(result.stdout.trim() || "[]"); } catch {}
  json(res, 200, rows || []);
}

// GET /vms/{slug}/db/columns?table=foo&schema=public
async function columns(req, res, { slug, query }) {
  const vm = await vmBySlug(slug);
  if (!vm) return bad(res, 404, "vm not found", "not_found");
  const table = String(query.table || "").trim();
  const schema = String(query.schema || "public").trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(table)) return bad(res, 400, "invalid table", "invalid_table");
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(schema)) return bad(res, 400, "invalid schema", "invalid_schema");

  const sql = `SELECT json_agg(row_to_json(t)) FROM (
       SELECT column_name AS name, data_type, is_nullable, column_default, ordinal_position
       FROM information_schema.columns
       WHERE table_schema = '${schema}' AND table_name = '${table}'
       ORDER BY ordinal_position
     ) t;`;
  let result;
  try { result = await runPsql(vm.ip, sql, { tuplesOnly: true }); }
  catch (e) { return bad(res, e.status || 502, e.message, "ssh_error"); }
  if (result.code !== 0) return bad(res, 500, result.stderr.slice(0, 500), "psql_error");
  let rows = [];
  try { rows = JSON.parse(result.stdout.trim() || "[]"); } catch {}
  json(res, 200, rows || []);
}

// GET /vms/{slug}/db/sizes
async function sizes(req, res, { slug }) {
  const vm = await vmBySlug(slug);
  if (!vm) return bad(res, 404, "vm not found", "not_found");
  const sql = `SELECT json_build_object(
       'db_size_bytes', pg_database_size('postgres'),
       'tables', (
         SELECT json_agg(row_to_json(x)) FROM (
           SELECT schemaname AS schema, tablename AS name,
             pg_total_relation_size(quote_ident(schemaname)||'.'||quote_ident(tablename))::bigint AS size_bytes
           FROM pg_tables
           WHERE schemaname NOT IN ('pg_catalog','information_schema','pg_toast')
           ORDER BY size_bytes DESC LIMIT 20
         ) x
       )
     );`;
  let result;
  try { result = await runPsql(vm.ip, sql, { tuplesOnly: true }); }
  catch (e) { return bad(res, e.status || 502, e.message, "ssh_error"); }
  if (result.code !== 0) return bad(res, 500, result.stderr.slice(0, 500), "psql_error");
  let out = {};
  try { out = JSON.parse(result.stdout.trim() || "{}"); } catch {}
  json(res, 200, out || {});
}

module.exports = { query, tables, columns, sizes };
