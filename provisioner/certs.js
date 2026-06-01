// BYO SSL cert per app+hostname. Stored encrypted (AES-256-GCM)
// with the provisioner master key. Storage only — actual Caddy
// wire-up follows in a later pass.

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
  return buf.length === 32 ? buf : null;
}
const KEY = loadKey();
if (!KEY) console.error("[certs] PROVISIONER_SECRET_KEY missing or invalid — endpoints will refuse");

function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { iv, ciphertext: enc, auth_tag: cipher.getAuthTag() };
}

function parseCertMeta(certPem) {
  // Lightweight metadata parse — uses node's X509Certificate (Node 15+).
  try {
    const x509 = new crypto.X509Certificate(certPem);
    return {
      not_before: new Date(x509.validFrom).toISOString(),
      not_after:  new Date(x509.validTo).toISOString(),
      fingerprint_sha256: x509.fingerprint256.replace(/:/g, "").toLowerCase(),
      subject: x509.subject,
    };
  } catch {
    return null;
  }
}

async function appBySlugAndId(slug, id) {
  return db.oneJson(
    `SELECT row_to_json(t) FROM (SELECT id FROM apps WHERE customer_slug = $1 AND id = $2) t`,
    [slug, id],
  );
}

async function audit(req, action, slug, details = "") {
  try {
    await db.exec(
      `INSERT INTO audit_log (actor, action, slug, details) VALUES ($1, $2, $3, $4)`,
      [(req.headers["x-wcn-actor"] || "system").toString().slice(0, 120), action, slug, details],
    );
  } catch (e) { console.error("[certs] audit failed:", e.message); }
}

function requireKey(res) {
  if (!KEY) { bad(res, 500, "certs disabled: PROVISIONER_SECRET_KEY not configured", "certs_disabled"); return false; }
  return true;
}

// ── GET — return metadata only, never the PEMs ──────────────────────
async function get(req, res, { slug, params }) {
  if (!requireKey(res)) return;
  const app = await appBySlugAndId(slug, params.id);
  if (!app) return bad(res, 404, "app not found", "not_found");
  const row = await db.oneJson(
    `SELECT row_to_json(t) FROM (
       SELECT id, hostname, not_before, not_after, fingerprint_sha256, uploaded_at, chain_pem IS NOT NULL AS has_chain
       FROM custom_certs WHERE app_id = $1 AND hostname = $2
     ) t`,
    [app.id, params.hostname],
  );
  if (!row) return json(res, 200, { hostname: params.hostname, uploaded: false });
  json(res, 200, { ...row, uploaded: true });
}

// ── POST — store cert + key (encrypted) ─────────────────────────────
async function upload(req, res, { slug, params, body }) {
  if (!requireKey(res)) return;
  const app = await appBySlugAndId(slug, params.id);
  if (!app) return bad(res, 404, "app not found", "not_found");

  const cert = body && body.cert_pem;
  const key = body && body.key_pem;
  if (!cert || !cert.includes("BEGIN CERTIFICATE")) return bad(res, 400, "cert_pem missing or malformed", "invalid_cert");
  if (!key  || !key.includes("PRIVATE KEY")) return bad(res, 400, "key_pem missing or malformed", "invalid_key");

  const meta = parseCertMeta(cert);
  if (!meta) return bad(res, 400, "could not parse certificate", "unparseable_cert");

  // Validate cert + key actually pair
  try {
    const test = crypto.createPrivateKey(key);
    if (!test) throw new Error("invalid key");
    // crypto.X509Certificate.checkPrivateKey is Node 19+; skip pairing check on older nodes
    if (typeof new crypto.X509Certificate(cert).checkPrivateKey === "function") {
      const ok = new crypto.X509Certificate(cert).checkPrivateKey(test);
      if (!ok) return bad(res, 400, "private key does not match certificate", "key_mismatch");
    }
  } catch (e) {
    return bad(res, 400, `key parse failed: ${e.message}`, "invalid_key");
  }

  const ce = encrypt(cert);
  const ke = encrypt(key);

  await db.exec(
    `INSERT INTO custom_certs
       (app_id, hostname, cert_iv, cert_ciphertext, cert_auth_tag,
        key_iv, key_ciphertext, key_auth_tag, chain_pem,
        not_before, not_after, fingerprint_sha256, uploaded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
     ON CONFLICT (app_id, hostname) DO UPDATE
       SET cert_iv = EXCLUDED.cert_iv,
           cert_ciphertext = EXCLUDED.cert_ciphertext,
           cert_auth_tag = EXCLUDED.cert_auth_tag,
           key_iv = EXCLUDED.key_iv,
           key_ciphertext = EXCLUDED.key_ciphertext,
           key_auth_tag = EXCLUDED.key_auth_tag,
           chain_pem = EXCLUDED.chain_pem,
           not_before = EXCLUDED.not_before,
           not_after = EXCLUDED.not_after,
           fingerprint_sha256 = EXCLUDED.fingerprint_sha256,
           uploaded_at = now()`,
    [
      app.id, params.hostname,
      ce.iv, ce.ciphertext, ce.auth_tag,
      ke.iv, ke.ciphertext, ke.auth_tag,
      body.chain_pem || null,
      meta.not_before, meta.not_after, meta.fingerprint_sha256,
    ],
  );
  await audit(req, "app.cert.upload", slug, `app=${app.id} hostname=${params.hostname} fp=${meta.fingerprint_sha256.slice(0,16)}`);
  json(res, 201, {
    hostname: params.hostname, uploaded: true,
    not_before: meta.not_before, not_after: meta.not_after,
    fingerprint_sha256: meta.fingerprint_sha256,
    subject: meta.subject,
  });
}

async function del(req, res, { slug, params }) {
  if (!requireKey(res)) return;
  const app = await appBySlugAndId(slug, params.id);
  if (!app) return bad(res, 404, "app not found", "not_found");
  await db.exec(
    `DELETE FROM custom_certs WHERE app_id = $1 AND hostname = $2`,
    [app.id, params.hostname],
  );
  await audit(req, "app.cert.delete", slug, `app=${app.id} hostname=${params.hostname}`);
  json(res, 200, { ok: true });
}

module.exports = { get, upload, delete: del };
