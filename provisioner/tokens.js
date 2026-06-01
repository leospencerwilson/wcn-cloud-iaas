// T3 #26 — Customer-issued API tokens.

const crypto = require("crypto");
const db = require("./db");

const TOKEN_PREFIX = "wcn_";  // recognisable in logs/grep
const SCOPE_RE = /^(vms|apps|backups|domains|secrets|audit|metrics):(read|write|admin)$/;

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
  } catch (e) { console.error("[tokens] audit failed:", e.message); }
}

function generate() {
  const entropy = crypto.randomBytes(24).toString("base64url");
  const prefix = crypto.randomBytes(4).toString("hex");
  const plain = `${TOKEN_PREFIX}${prefix}_${entropy}`;
  const hash = crypto.createHash("sha256").update(plain).digest("hex");
  return { plain, prefix, hash };
}

// GET /customers/{slug}/tokens
async function list(req, res, { slug }) {
  const rows = await db.rowsJson(
    `SELECT row_to_json(t) FROM (
       SELECT id, user_email, name, prefix, scopes, created_at, last_used_at, expires_at, revoked_at
       FROM customer_api_tokens WHERE customer_slug = $1 ORDER BY created_at DESC
     ) t`,
    [slug],
  );
  json(res, 200, rows);
}

// POST /customers/{slug}/tokens { name, scopes[], expires_at?, user_email }
async function issue(req, res, { slug, body }) {
  const name = String(body.name || "").trim();
  if (!name || name.length > 80) return bad(res, 400, "name required (max 80 chars)", "invalid_name");
  const scopes = Array.isArray(body.scopes) ? body.scopes : [];
  if (scopes.length === 0) return bad(res, 400, "at least one scope required", "missing_scopes");
  for (const s of scopes) {
    if (!SCOPE_RE.test(s)) return bad(res, 400, `invalid scope '${s}'`, "invalid_scope");
  }
  const user_email = String(body.user_email || req.headers["x-wcn-actor"] || "").toLowerCase().trim();
  if (!user_email) return bad(res, 400, "user_email or x-wcn-actor required", "missing_actor");

  const { plain, prefix, hash } = generate();
  const expires_at = body.expires_at && !Number.isNaN(new Date(body.expires_at).getTime())
    ? new Date(body.expires_at).toISOString() : null;

  const row = await db.oneJson(
    `WITH ins AS (
       INSERT INTO customer_api_tokens (customer_slug, user_email, name, prefix, hash, scopes, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6::text[], $7)
       RETURNING *
     )
     SELECT row_to_json(t) FROM ins t`,
    [slug, user_email, name, prefix, hash, scopes, expires_at],
  );
  await audit(req, "token.issue", slug, `name=${name} scopes=${scopes.join(",")} prefix=${prefix}`);

  // plaintext returned ONCE — caller must store it
  json(res, 201, {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes,
    created_at: row.created_at,
    expires_at: row.expires_at,
    token: plain,                  // never returned again
    message: "Store this token securely — it will not be shown again.",
  });
}

// DELETE /customers/{slug}/tokens/{id}
async function revoke(req, res, { slug, params }) {
  const id = parseInt(params.id, 10);
  if (!Number.isInteger(id) || id < 1) return bad(res, 400, "invalid id", "invalid_id");
  const row = await db.oneJson(
    `SELECT row_to_json(t) FROM (
       SELECT id, name, prefix FROM customer_api_tokens WHERE id = $1 AND customer_slug = $2 AND revoked_at IS NULL
     ) t`,
    [id, slug],
  );
  if (!row) return bad(res, 404, "token not found", "not_found");
  await db.exec(`UPDATE customer_api_tokens SET revoked_at = now() WHERE id = $1`, [id]);
  await audit(req, "token.revoke", slug, `name=${row.name} prefix=${row.prefix}`);
  json(res, 200, { ok: true });
}

// POST /tokens/validate { token }
// Used by the console to resolve a token to a customer + scopes.
async function validate(req, res, { body }) {
  const token = body && body.token;
  if (!token || typeof token !== "string" || !token.startsWith(TOKEN_PREFIX)) {
    return bad(res, 401, "invalid token", "invalid_token");
  }
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  const row = await db.oneJson(
    `SELECT row_to_json(t) FROM (
       SELECT id, customer_slug, user_email, name, prefix, scopes, expires_at, revoked_at
       FROM customer_api_tokens WHERE hash = $1
     ) t`,
    [hash],
  );
  if (!row || row.revoked_at) return bad(res, 401, "token revoked or unknown", "invalid_token");
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    return bad(res, 401, "token expired", "expired_token");
  }
  // Record last-used (best-effort, fire-and-forget)
  db.exec(`UPDATE customer_api_tokens SET last_used_at = now() WHERE id = $1`, [row.id])
    .catch((e) => console.error("[tokens] last_used update failed:", e.message));

  json(res, 200, {
    customer_slug: row.customer_slug,
    user_email: row.user_email,
    scopes: row.scopes,
    token_id: row.id,
  });
}

module.exports = { list, issue, revoke, validate };
