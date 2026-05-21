// ops_db wrapper. Shells out to psql since we keep the provisioner npm-dep-free.
// All values pass via psql's :'name' variable substitution (proper SQL quoting,
// not naive string concat). Result rows are JSON via row_to_json so parsing is
// a one-liner.

const { spawn } = require("child_process");

const OPS_DB_URL = process.env.OPS_DB_URL;
if (!OPS_DB_URL) {
  console.error("OPS_DB_URL not set"); process.exit(1);
}

// pgQuote: format a JS value as a Postgres literal. Used for inline SQL where
// we can't use psql -v (e.g. arrays, JSON). Strings are single-quote-escaped.
function pgQuote(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (v instanceof Date) return `'${v.toISOString()}'::timestamptz`;
  if (Array.isArray(v))   return `ARRAY[${v.map(pgQuote).join(",")}]`;
  if (typeof v === "object") return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

// Run psql with the SQL; returns stdout as string. Throws on non-zero exit.
function runPsql(sql) {
  return new Promise((resolve, reject) => {
    const args = [OPS_DB_URL, "-X", "-At", "-F", "|", "-q", "-c", sql];
    const child = spawn("psql", args, {
      env: { ...process.env, PGOPTIONS: "--client-min-messages=warning" },
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      if (code !== 0) return reject(Object.assign(new Error(err.trim() || `psql exit ${code}`), { code: "db_error" }));
      resolve(out);
    });
    child.on("error", reject);
  });
}

// Build SQL with $1, $2, … substituted with pgQuote'd params.
function format(sql, params = []) {
  return sql.replace(/\$(\d+)/g, (_, n) => pgQuote(params[+n - 1]));
}

// Query returning rows-of-columns (split by |). Use for ad-hoc queries.
async function rows(sql, params = []) {
  const out = await runPsql(format(sql, params));
  if (!out.trim()) return [];
  return out.trim().split("\n").map((l) => l.split("|"));
}

// Query returning rows as parsed JSON objects. SQL must SELECT row_to_json(t)
// from a subquery aliased t.
async function rowsJson(sql, params = []) {
  const r = await rows(sql, params);
  return r.map((cols) => JSON.parse(cols[0]));
}

// First-row-or-null variant of rowsJson.
async function oneJson(sql, params = []) {
  const r = await rowsJson(sql, params);
  return r[0] ?? null;
}

// Run a statement that doesn't return rows (INSERT/UPDATE/DELETE without RETURNING).
async function exec(sql, params = []) {
  await runPsql(format(sql, params));
}

module.exports = { rows, rowsJson, oneJson, exec, pgQuote };
