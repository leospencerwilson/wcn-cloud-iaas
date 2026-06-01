// ops_db wrapper. Shells out to psql since we keep the provisioner npm-dep-free.
// All values pass via psql's quote-escaping helper (no naive string concat).
// Results selecting row_to_json(t) come back as JSON for easy parsing.

const { spawn } = require("child_process");

const OPS_DB_URL = process.env.OPS_DB_URL;
if (!OPS_DB_URL) {
  console.error("OPS_DB_URL not set"); process.exit(1);
}

function pgQuote(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (v instanceof Date) return `'${v.toISOString()}'::timestamptz`;
  if (Array.isArray(v))   return `ARRAY[${v.map(pgQuote).join(",")}]`;
  if (typeof v === "object") return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

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

function format(sql, params = []) {
  return sql.replace(/\$(\d+)/g, (_, n) => pgQuote(params[+n - 1]));
}

async function rows(sql, params = []) {
  const out = await runPsql(format(sql, params));
  if (!out.trim()) return [];
  return out.trim().split("\n").map((l) => l.split("|"));
}

async function rowsJson(sql, params = []) {
  // Each line of psql output is one row's row_to_json JSON document.
  // We do NOT split on the | column delimiter — row_to_json values can
  // legitimately contain | (e.g. Sanctum tokens of the form id|secret).
  const out = await runPsql(format(sql, params));
  if (!out.trim()) return [];
  return out.trim().split("\n").map((line) => {
    try { return JSON.parse(line); }
    catch (e) {
      const err = new Error(`psql output not valid JSON: ${line.slice(0, 120)}…`);
      err.code = "db_parse_error";
      throw err;
    }
  });
}

async function oneJson(sql, params = []) {
  const r = await rowsJson(sql, params);
  return r[0] ?? null;
}

async function exec(sql, params = []) {
  await runPsql(format(sql, params));
}

module.exports = { rows, rowsJson, oneJson, exec, pgQuote };
