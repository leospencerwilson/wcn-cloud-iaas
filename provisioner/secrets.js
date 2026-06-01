// App secrets — AES-256-GCM at rest. Master key from
// PROVISIONER_SECRET_KEY env (32 bytes, hex- or base64-encoded).

const crypto = require("crypto");
const db = require("./db");

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
function bad(res, code, err, error_code = "bad_request") {
  json(res, code, { error: err, code: error_code });
}

function loadKey() {
  const raw = process.env.PROVISIONER_SECRET_KEY;
  if (!raw) return null;
  let buf;
  if (/^[0-9a-f]{64}$/i.test(raw)) buf = Buffer.from(raw, "hex");
  else if (/^[A-Za-z0-9+/=]+$/.test(raw)) buf = Buffer.from(raw, "base64");
  else buf = Buffer.from(raw, "utf8");
  if (buf.length !== 32) {
    console.error("[secrets] PROVISIONER_SECRET_KEY must decode to 32 bytes");
    return null;
  }
  return buf;
}
const KEY = loadKey();
if (!KEY) console.error("[secrets] PROVISIONER_SECRET_KEY not set — secrets endpoints will refuse");

function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { iv, ciphertext: enc, auth_tag: cipher.getAuthTag() };
}

function decrypt(row) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, row.iv);
  decipher.setAuthTag(row.auth_tag);
  const buf = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]);
  return buf.toString("utf8");
}

async function appBySlugAndId(slug, id) {
  return db.oneJson(
    `SELECT row_to_json(t) FROM (
       SELECT id FROM apps WHERE customer_slug = $1 AND id = $2
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
  } catch (e) { console.error("[secrets] audit failed:", e.message); }
}

function requireKey(res) {
  if (!KEY) {
    bad(res, 500, "secrets disabled: PROVISIONER_SECRET_KEY not configured", "secrets_disabled");
    return false;
  }
  return true;
}

async function list(req, res, { slug, params }) {
  if (!requireKey(res)) return;
  const app = await appBySlugAndId(slug, params.id);
  if (!app) return bad(res, 404, "app not found", "not_found");
  const rows = await db.rowsJson(
    `SELECT row_to_json(t) FROM (
       SELECT key, created_at, last_rotated_at FROM app_secrets WHERE app_id = $1 ORDER BY key
     ) t`,
    [app.id],
  );
  json(res, 200, rows);
}

async function put(req, res, { slug, params, body }) {
  if (!requireKey(res)) return;
  const app = await appBySlugAndId(slug, params.id);
  if (!app) return bad(res, 404, "app not found", "not_found");
  if (!Array.isArray(body)) return bad(res, 400, "expected array of {key,value}", "invalid_body");

  for (const item of body) {
    if (!item.key || !/^[A-Z][A-Z0-9_]{0,63}$/.test(item.key)) {
      return bad(res, 400, `invalid key '${item.key}' — must match [A-Z][A-Z0-9_]{0,63}`, "invalid_key");
    }
    if (typeof item.value !== "string") {
      return bad(res, 400, `value for '${item.key}' must be string`, "invalid_value");
    }
  }

  for (const item of body) {
    const { iv, ciphertext, auth_tag } = encrypt(item.value);
    await db.exec(
      `INSERT INTO app_secrets (app_id, key, iv, ciphertext, auth_tag)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (app_id, key) DO UPDATE
         SET iv = EXCLUDED.iv,
             ciphertext = EXCLUDED.ciphertext,
             auth_tag = EXCLUDED.auth_tag,
             last_rotated_at = now()`,
      [app.id, item.key, iv, ciphertext, auth_tag],
    );
  }
  await audit(req, "app.secret.put", slug, `app=${app.id} keys=${body.map((b) => b.key).join(",")}`);

  const rows = await db.rowsJson(
    `SELECT row_to_json(t) FROM (
       SELECT key, created_at, last_rotated_at FROM app_secrets WHERE app_id = $1 ORDER BY key
     ) t`,
    [app.id],
  );
  json(res, 200, rows);
}

async function reveal(req, res, { slug, params, body }) {
  if (!requireKey(res)) return;
  const app = await appBySlugAndId(slug, params.id);
  if (!app) return bad(res, 404, "app not found", "not_found");
  if (!body.key) return bad(res, 400, "key required", "missing_key");

  const row = await db.oneJson(
    `SELECT row_to_json(t) FROM (
       SELECT key, iv, ciphertext, auth_tag FROM app_secrets WHERE app_id = $1 AND key = $2
     ) t`,
    [app.id, body.key],
  );
  if (!row) return bad(res, 404, "secret not found", "not_found");
  try {
    // db.oneJson serialised the bytea as base64 inside JSON. Coerce back.
    const ivBuf = Buffer.from(row.iv, "base64");
    const ctBuf = Buffer.from(row.ciphertext, "base64");
    const tagBuf = Buffer.from(row.auth_tag, "base64");
    const value = decrypt({ iv: ivBuf, ciphertext: ctBuf, auth_tag: tagBuf });
    await audit(req, "app.secret.reveal", slug, `app=${app.id} key=${body.key}`);
    json(res, 200, { key: body.key, value });
  } catch (e) {
    return bad(res, 500, `decrypt failed: ${e.message}`, "decrypt_failed");
  }
}

async function del(req, res, { slug, params }) {
  if (!requireKey(res)) return;
  const app = await appBySlugAndId(slug, params.id);
  if (!app) return bad(res, 404, "app not found", "not_found");
  if (!params.key) return bad(res, 400, "key required", "missing_key");
  await db.exec(`DELETE FROM app_secrets WHERE app_id = $1 AND key = $2`, [app.id, params.key]);
  await audit(req, "app.secret.delete", slug, `app=${app.id} key=${params.key}`);
  json(res, 200, { ok: true });
}

module.exports = { list, put, reveal, delete: del };
