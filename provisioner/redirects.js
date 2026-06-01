// HTTP redirect rules per app. CRUD over app_redirects. Storage only —
// no Caddy/Coolify wire-up yet (follows in a later pass).

const db = require("./db");

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
function bad(res, code, err, error_code = "bad_request") {
  json(res, code, { error: err, code: error_code });
}

const HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,253})?(?:\.[a-z0-9](?:[a-z0-9-]{0,253})?)+$/i;
const URL_RE = /^https?:\/\/[^\s<>"]+$/i;

async function appBySlugAndId(slug, id) {
  return db.oneJson(
    `SELECT row_to_json(t) FROM (
       SELECT a.id FROM apps a WHERE a.customer_slug = $1 AND a.id = $2
     ) t`,
    [slug, id],
  );
}

async function audit(req, action, slug, details = "") {
  try {
    await db.exec(
      `INSERT INTO audit_log (actor, action, slug, details) VALUES ($1, $2, $3, $4)`,
      [(req.headers["x-wcn-actor"] || "system").toString().slice(0, 120), action, slug, details],
    );
  } catch (e) { console.error("[redirects] audit failed:", e.message); }
}

async function list(req, res, { slug, params }) {
  const app = await appBySlugAndId(slug, params.id);
  if (!app) return bad(res, 404, "app not found", "not_found");
  const rows = await db.rowsJson(
    `SELECT row_to_json(t) FROM (
       SELECT id, from_host, from_path, to_url, status_code, enabled, created_at
       FROM app_redirects WHERE app_id = $1 ORDER BY id
     ) t`,
    [app.id],
  );
  json(res, 200, rows);
}

async function add(req, res, { slug, params, body }) {
  const app = await appBySlugAndId(slug, params.id);
  if (!app) return bad(res, 404, "app not found", "not_found");
  const from_host = String(body.from_host || "").toLowerCase().trim();
  const from_path = String(body.from_path || "/").trim() || "/";
  const to_url = String(body.to_url || "").trim();
  const status_code = parseInt(body.status_code || 301, 10);

  if (!HOST_RE.test(from_host)) return bad(res, 400, "invalid from_host", "invalid_from_host");
  if (!from_path.startsWith("/")) return bad(res, 400, "from_path must start with /", "invalid_path");
  if (!URL_RE.test(to_url)) return bad(res, 400, "to_url must be http(s)://...", "invalid_to_url");
  if (![301, 302].includes(status_code)) return bad(res, 400, "status_code must be 301 or 302", "invalid_status_code");

  const row = await db.oneJson(
    `WITH ins AS (
       INSERT INTO app_redirects (app_id, from_host, from_path, to_url, status_code)
       VALUES ($1, $2, $3, $4, $5) RETURNING *
     )
     SELECT row_to_json(t) FROM ins t`,
    [app.id, from_host, from_path, to_url, status_code],
  );
  await audit(req, "app.redirect.add", slug, `app=${app.id} ${from_host}${from_path} -> ${to_url} (${status_code})`);
  json(res, 201, row);
}

async function del(req, res, { slug, params }) {
  const app = await appBySlugAndId(slug, params.id);
  if (!app) return bad(res, 404, "app not found", "not_found");
  const rid = parseInt(params.rid, 10);
  if (!Number.isInteger(rid) || rid < 1) return bad(res, 400, "invalid id", "invalid_id");

  const r = await db.exec(
    `DELETE FROM app_redirects WHERE app_id = $1 AND id = $2`,
    [app.id, rid],
  );
  await audit(req, "app.redirect.delete", slug, `app=${app.id} rid=${rid}`);
  json(res, 200, { ok: true });
}

module.exports = { list, add, delete: del };
