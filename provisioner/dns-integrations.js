// Provisioner-side DNS integration accessor. Reads dns_integrations
// rows from the ops DB and decrypts the credentials blob using the
// same INTEGRATION_ENC_KEY as the console.
//
// Encryption layout matches lib/db/dns-integrations.ts:
//   base64( [12-byte IV][ciphertext][16-byte GCM tag] )

const crypto = require("crypto");
const db = require("./db");

const IV_BYTES = 12;
const TAG_BYTES = 16;

function key() {
  const raw = process.env.INTEGRATION_ENC_KEY;
  if (!raw || raw.length < 16) {
    throw new Error("INTEGRATION_ENC_KEY env var is missing or too short");
  }
  return crypto.createHash("sha256").update(raw, "utf8").digest();
}

function decryptJson(b64) {
  const blob = Buffer.from(b64, "base64");
  if (blob.length < IV_BYTES + TAG_BYTES + 1) {
    throw new Error("encrypted credentials blob too short");
  }
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(blob.length - TAG_BYTES);
  const ct = blob.subarray(IV_BYTES, blob.length - TAG_BYTES);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  const json = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  return JSON.parse(json);
}

async function getById(slug, id) {
  const row = await db.oneJson(
    `SELECT row_to_json(t) FROM (
       SELECT id::text, customer_slug, provider, display_name,
              encrypted_credentials, zones_cache
       FROM dns_integrations
       WHERE customer_slug = $1 AND id = $2
     ) t`,
    [slug, id],
  );
  if (!row) return null;
  return {
    id: row.id,
    customer_slug: row.customer_slug,
    provider: row.provider,
    display_name: row.display_name,
    credentials: decryptJson(row.encrypted_credentials),
    zones: row.zones_cache || [],
  };
}

// Pick the integration that owns the given hostname's zone, if any.
// Returns null when no connected provider matches.
async function findForHostname(slug, hostname) {
  const all = await db.rowsJson(
    `SELECT row_to_json(t) FROM (
       SELECT id::text, customer_slug, provider, display_name,
              encrypted_credentials, zones_cache
       FROM dns_integrations
       WHERE customer_slug = $1
     ) t`,
    [slug],
  );
  let best = null;
  let bestZoneLen = 0;
  for (const r of all) {
    for (const z of r.zones_cache || []) {
      const zone = String(z.name || "").toLowerCase();
      if (!zone) continue;
      if (hostname === zone || hostname.endsWith("." + zone)) {
        if (zone.length > bestZoneLen) {
          best = { row: r, zone: z };
          bestZoneLen = zone.length;
        }
      }
    }
  }
  if (!best) return null;
  return {
    integration: {
      id: best.row.id,
      customer_slug: best.row.customer_slug,
      provider: best.row.provider,
      display_name: best.row.display_name,
      credentials: decryptJson(best.row.encrypted_credentials),
    },
    zone: best.zone,
  };
}

module.exports = { getById, findForHostname, decryptJson };
