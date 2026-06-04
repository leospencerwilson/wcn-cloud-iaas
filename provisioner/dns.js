// DNS provider integration HTTP handlers. Mirrors the team/audit
// shape — every handler takes (req, res, { slug, ... }) and writes
// directly. Audited via the existing audit_log table.
//
// Routes (registered in server.js):
//   GET    /customers/{slug}/dns-integrations
//   POST   /customers/{slug}/dns-integrations            { provider, display_name, credentials }
//   GET    /customers/{slug}/dns-integrations/{id}
//   DELETE /customers/{slug}/dns-integrations/{id}
//   POST   /customers/{slug}/dns-integrations/{id}/test
//   POST   /customers/{slug}/dns-integrations/{id}/zones    (refresh + return)
//   GET    /customers/{slug}/dns-providers                  (static metadata)

const crypto = require("crypto");
const db = require("./db");
const { PROVIDER_META, PROVIDER_KEYS, buildClient } = require("../lib/dns/providers");

const IV_BYTES = 12;
const TAG_BYTES = 16;

function encKey() {
  const raw = process.env.INTEGRATION_ENC_KEY;
  if (!raw || raw.length < 16) throw new Error("INTEGRATION_ENC_KEY env var missing or too short");
  return crypto.createHash("sha256").update(raw, "utf8").digest();
}

function encryptJson(value) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", encKey(), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString("base64");
}

function decryptJson(b64) {
  const blob = Buffer.from(b64, "base64");
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(blob.length - TAG_BYTES);
  const ct = blob.subarray(IV_BYTES, blob.length - TAG_BYTES);
  const decipher = crypto.createDecipheriv("aes-256-gcm", encKey(), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8"));
}

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
  } catch (e) {
    console.error("[dns] audit failed:", e.message);
  }
}

// GET /dns-providers — static metadata, no slug.
async function providersMeta(req, res) {
  const out = PROVIDER_KEYS.map((k) => ({ key: k, ...PROVIDER_META[k] }));
  return json(res, 200, out);
}

// GET /customers/{slug}/dns-integrations
async function list(req, res, { slug }) {
  const rows = await db.rowsJson(
    `SELECT row_to_json(t) FROM (
       SELECT id::text, provider, display_name, zones_cache,
              last_zone_sync_at, last_test_at, last_test_ok, last_test_error,
              created_at, created_by
       FROM dns_integrations
       WHERE customer_slug = $1
       ORDER BY created_at ASC
     ) t`,
    [slug],
  );
  return json(res, 200, rows);
}

// POST /customers/{slug}/dns-integrations
async function create(req, res, { slug, body }) {
  const provider = String(body.provider || "").toLowerCase();
  if (!PROVIDER_KEYS.includes(provider)) {
    return bad(res, 400, `unknown provider — must be one of: ${PROVIDER_KEYS.join(", ")}`, "unknown_provider");
  }
  const display_name = String(body.display_name || "").trim().slice(0, 80);
  if (!display_name) return bad(res, 400, "display_name is required", "missing_display_name");
  const credentials = body.credentials;
  if (!credentials || typeof credentials !== "object") {
    return bad(res, 400, "credentials object is required", "missing_credentials");
  }

  // Validate credentials by exercising the live API once before we store.
  let client;
  try {
    client = buildClient(provider, credentials);
  } catch (e) {
    return bad(res, 400, e.message, "invalid_credentials");
  }
  const test = await client.test();
  if (!test.ok) return bad(res, 400, `credentials rejected: ${test.error}`, "credentials_rejected");

  let zones = [];
  try {
    zones = await client.listZones();
  } catch (e) {
    return bad(res, 400, `could not list zones: ${e.message}`, "zone_list_failed");
  }

  const actor = (req.headers["x-wcn-actor"] || "system").toString().slice(0, 120);

  let row;
  try {
    row = await db.oneJson(
      `INSERT INTO dns_integrations
         (customer_slug, provider, display_name, encrypted_credentials,
          zones_cache, last_zone_sync_at, last_test_at, last_test_ok, created_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, now(), now(), true, $6)
       RETURNING row_to_json(dns_integrations.*)`,
      [slug, provider, display_name, encryptJson(credentials), JSON.stringify(zones), actor],
    );
  } catch (e) {
    if (String(e.message).includes("dns_integrations_slug_name_uq")) {
      return bad(res, 409, "a DNS integration with that display name already exists", "name_taken");
    }
    throw e;
  }

  await audit(req, "dns.integration.create", slug, `provider=${provider} name=${display_name} zones=${zones.length}`);

  delete row.encrypted_credentials;
  return json(res, 201, row);
}

// GET /customers/{slug}/dns-integrations/{id}
async function get(req, res, { slug, id }) {
  const row = await db.oneJson(
    `SELECT row_to_json(t) FROM (
       SELECT id::text, provider, display_name, zones_cache,
              last_zone_sync_at, last_test_at, last_test_ok, last_test_error,
              created_at, created_by
       FROM dns_integrations WHERE customer_slug = $1 AND id = $2
     ) t`,
    [slug, id],
  );
  if (!row) return bad(res, 404, "not found", "not_found");
  return json(res, 200, row);
}

// DELETE /customers/{slug}/dns-integrations/{id}
async function remove(req, res, { slug, id }) {
  // Surface a friendlier error if customer is trying to delete an
  // integration that's still cleaning up records on existing domains.
  const inUse = await db.oneJson(
    `SELECT row_to_json(t) FROM (
       SELECT count(*)::int AS n FROM domains
       WHERE dns_integration_id = $1 AND status IN ('pending','active')
     ) t`,
    [id],
  );
  if (inUse && inUse.n > 0) {
    return bad(
      res,
      409,
      `still owns DNS records for ${inUse.n} active domain(s) — remove those domains first`,
      "integration_in_use",
    );
  }
  const r = await db.oneJson(
    `SELECT row_to_json(t) FROM (
       SELECT id::text, provider, display_name FROM dns_integrations
       WHERE customer_slug = $1 AND id = $2
     ) t`,
    [slug, id],
  );
  if (!r) return bad(res, 404, "not found", "not_found");
  await db.exec(`DELETE FROM dns_integrations WHERE customer_slug = $1 AND id = $2`, [slug, id]);
  await audit(req, "dns.integration.delete", slug, `provider=${r.provider} name=${r.display_name}`);
  return json(res, 200, { ok: true });
}

// POST /customers/{slug}/dns-integrations/{id}/test
async function test(req, res, { slug, id }) {
  const row = await db.oneJson(
    `SELECT row_to_json(t) FROM (
       SELECT provider, encrypted_credentials FROM dns_integrations
       WHERE customer_slug = $1 AND id = $2
     ) t`,
    [slug, id],
  );
  if (!row) return bad(res, 404, "not found", "not_found");
  const client = buildClient(row.provider, decryptJson(row.encrypted_credentials));
  const result = await client.test();
  await db.exec(
    `UPDATE dns_integrations
        SET last_test_at = now(),
            last_test_ok = $2,
            last_test_error = $3,
            updated_at = now()
      WHERE customer_slug = $1 AND id = $4`,
    [slug, result.ok, result.ok ? null : result.error, id],
  );
  return json(res, 200, result);
}

// POST /customers/{slug}/dns-integrations/{id}/zones — refresh
async function refreshZones(req, res, { slug, id }) {
  const row = await db.oneJson(
    `SELECT row_to_json(t) FROM (
       SELECT provider, encrypted_credentials FROM dns_integrations
       WHERE customer_slug = $1 AND id = $2
     ) t`,
    [slug, id],
  );
  if (!row) return bad(res, 404, "not found", "not_found");
  const client = buildClient(row.provider, decryptJson(row.encrypted_credentials));
  let zones;
  try {
    zones = await client.listZones();
  } catch (e) {
    return bad(res, 502, e.message, "zone_list_failed");
  }
  await db.exec(
    `UPDATE dns_integrations
        SET zones_cache = $2::jsonb, last_zone_sync_at = now(), updated_at = now()
      WHERE customer_slug = $1 AND id = $3`,
    [slug, JSON.stringify(zones), id],
  );
  return json(res, 200, zones);
}

module.exports = {
  providersMeta,
  list,
  create,
  get,
  remove,
  test,
  refreshZones,
};
