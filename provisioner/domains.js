// Custom-domain lifecycle. Replaces the 501 stubs in apps.js.
//
// Flow:
//   1. POST  /apps/{id}/domains             { hostname }
//      → Create CF custom hostname (DV via TXT). Insert domains row
//        (status='pending'). Return 202 with the CNAME instructions
//        the customer must follow.
//
//   2. GET   /apps/{id}/domains/{hostname}/status
//      → Query CF for current state. If newly active (both hostname
//        + ssl active in CF), patch Coolify app FQDN + add tunnel
//        ingress entry + flip domains.status='active'. Return state.
//
//   3. DELETE /apps/{id}/domains/{hostname}
//      → Remove from Coolify FQDN list, remove tunnel ingress entry,
//        delete CF custom hostname, mark domains row 'deleted'.

const https = require("https");
const db = require("./db");
const dnsIntegrations = require("./dns-integrations");
const { buildClient } = require("../lib/dns/providers");
const coolify = require("./coolify");

const CF_API_TOKEN = process.env.CF_API_TOKEN;
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_ZONE_ID = process.env.CF_ZONE_ID;
const TUNNEL_TARGET = process.env.WCN_TUNNEL_TARGET || "http://localhost:80";

const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

if (!CF_API_TOKEN || !CF_ACCOUNT_ID || !CF_ZONE_ID) {
  console.error("[domains] CF_API_TOKEN / CF_ACCOUNT_ID / CF_ZONE_ID missing — domain endpoints will fail");
}

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
function bad(res, code, err, error_code = "bad_request") {
  json(res, code, { error: err, code: error_code });
}

function cfApi(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname: "api.cloudflare.com",
        port: 443,
        path: `/client/v4${apiPath}`,
        method,
        headers: {
          Authorization: `Bearer ${CF_API_TOKEN}`,
          "Content-Type": "application/json",
          ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(buf);
            if (!parsed.success) {
              const msg = (parsed.errors || []).map((e) => `${e.code}: ${e.message}`).join("; ");
              return reject(Object.assign(new Error(`cloudflare: ${msg || buf.slice(0, 200)}`), { status: 502 }));
            }
            resolve(parsed);
          } catch (e) {
            reject(Object.assign(new Error(`cloudflare non-json: ${buf.slice(0, 200)}`), { status: 502 }));
          }
        });
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function appBySlugAndId(slug, id) {
  return db.oneJson(
    `SELECT row_to_json(t) FROM (
       SELECT a.*, v.ip AS vm_ip, v.tunnel_id
       FROM apps a JOIN vms v ON v.customer_slug = a.customer_slug
       WHERE a.customer_slug = $1 AND a.id = $2
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
  } catch (e) {
    console.error("[domains] audit insert failed:", e.message);
  }
}

// ── 1. POST /apps/{id}/domains ───────────────────────────────────────
async function add(req, res, { slug, params, body }) {
  const app = await appBySlugAndId(slug, params.id);
  if (!app) return bad(res, 404, "app not found", "not_found");
  const hostname = String(body.hostname || "").toLowerCase().trim();
  if (!HOSTNAME_RE.test(hostname)) return bad(res, 400, "invalid hostname", "invalid_hostname");
  if (hostname.endsWith(".western-communication.com") || hostname.endsWith(".dreadnaught.western-communication.com")) {
    return bad(res, 400, "managed-zone hostnames are not allowed as custom domains", "reserved_hostname");
  }

  // Check if already attached
  const existing = await db.oneJson(
    `SELECT row_to_json(t) FROM (
       SELECT hostname, app_id, status FROM domains WHERE hostname = $1 AND status != 'deleted'
     ) t`,
    [hostname],
  );
  if (existing) {
    if (existing.app_id === app.id) {
      return json(res, 200, { hostname, status: existing.status, message: "already attached to this app" });
    }
    return bad(res, 409, "hostname already attached to another customer", "hostname_taken");
  }

  // Create CF custom hostname
  let hid;
  const lookup = await cfApi("GET", `/zones/${CF_ZONE_ID}/custom_hostnames?hostname=${encodeURIComponent(hostname)}`);
  if (lookup.result && lookup.result.length > 0) {
    hid = lookup.result[0].id;
  } else {
    const create = await cfApi("POST", `/zones/${CF_ZONE_ID}/custom_hostnames`, {
      hostname,
      ssl: { method: "txt", type: "dv", settings: { min_tls_version: "1.2" } },
    });
    hid = create.result.id;
  }

  await db.exec(
    `INSERT INTO domains (hostname, customer_slug, cf_custom_hostname_id, app_id, status)
     VALUES ($1, $2, $3, $4, 'pending')
     ON CONFLICT (hostname) DO UPDATE
       SET customer_slug = EXCLUDED.customer_slug,
           cf_custom_hostname_id = EXCLUDED.cf_custom_hostname_id,
           app_id = EXCLUDED.app_id,
           status = 'pending',
           deleted_at = NULL`,
    [hostname, slug, hid, app.id],
  );
  await audit(req, "domain.add", slug, `app=${app.id} hostname=${hostname} hid=${hid}`);
  // ── Auto-config CNAME at customer's connected DNS provider, if any. ──
  // Strictly additive: failure here doesn't fail the domain add — customer
  // still gets the manual instructions and can finish by hand. We capture
  // the upstream record IDs so the matching del() can clean up.
  let autoConfigured = null;
  try {
    const match = await dnsIntegrations.findForHostname(slug, hostname);
    if (match) {
      const client = buildClient(match.integration.provider, match.integration.credentials);
      const rec = await client.upsertRecord(match.zone.id, {
        name: hostname,
        type: "CNAME",
        content: `${slug}.western-communication.com`,
        ttl: 300,
        comment: `WCN Cloud: ${hostname}`,
      });
      await db.exec(
        `UPDATE domains
            SET dns_integration_id = $2, dns_record_id = $3, dns_zone_id = $4
          WHERE hostname = $1`,
        [hostname, match.integration.id, rec.id, match.zone.id],
      );
      autoConfigured = {
        provider: match.integration.provider,
        zone: match.zone.name,
        record_id: rec.id,
      };
      await audit(req, "domain.dns_autoconfig", slug, `hostname=${hostname} provider=${match.integration.provider} zone=${match.zone.name} record=${rec.id}`);
    }
  } catch (e) {
    console.error("[domains] DNS auto-config failed (non-fatal):", e.message);
    await audit(req, "domain.dns_autoconfig_failed", slug, `hostname=${hostname} error=${e.message.slice(0, 200)}`);
  }


  json(res, 202, {
    hostname,
    status: "pending",
    cf_custom_hostname_id: hid,
    cname_target: `${slug}.western-communication.com`,
    auto_configured: autoConfigured,
    instructions: `Add a CNAME record for ${hostname} pointing to ${slug}.western-communication.com. Once propagated, an SSL certificate will be issued automatically.`,
  });
}

// ── 2. GET /apps/{id}/domains/{hostname}/status ──────────────────────
async function status(req, res, { slug, params }) {
  const app = await appBySlugAndId(slug, params.id);
  if (!app) return bad(res, 404, "app not found", "not_found");
  const hostname = params.hostname.toLowerCase();

  const row = await db.oneJson(
    `SELECT row_to_json(t) FROM (
       SELECT * FROM domains WHERE hostname = $1 AND app_id = $2 AND status != 'deleted'
     ) t`,
    [hostname, app.id],
  );
  if (!row) return bad(res, 404, "domain not found", "not_found");

  const cf = await cfApi("GET", `/zones/${CF_ZONE_ID}/custom_hostnames/${row.cf_custom_hostname_id}`);
  const hostStatus = cf.result.status;
  const sslStatus = cf.result.ssl && cf.result.ssl.status;
  const verificationErrors = (cf.result.verification_errors || []).concat(
    (cf.result.ssl && cf.result.ssl.verification_errors) || [],
  );

  // Detailed customer-facing state
  let state = row.status;
  if (hostStatus === "active" && sslStatus === "active") {
    state = "active";
  } else if (sslStatus && sslStatus !== "active" && sslStatus !== "pending_validation" && sslStatus !== "pending_issuance" && sslStatus !== "pending_deployment") {
    state = "failed";
  } else {
    state = "pending";
  }

  // On first transition to active, do the wiring
  if (state === "active" && row.status !== "active") {
    try {
      await activate(slug, app, hostname);
      await db.exec(
        `UPDATE domains SET status = 'active', activated_at = now() WHERE hostname = $1`,
        [hostname],
      );
      await audit(req, "domain.active", slug, `app=${app.id} hostname=${hostname}`);
    } catch (e) {
      await db.exec(
        `UPDATE domains SET status = 'failed' WHERE hostname = $1`,
        [hostname],
      );
      return bad(res, 502, `activation step failed: ${e.message}`, "activation_failed");
    }
  } else if (state === "failed" && row.status !== "failed") {
    await db.exec(`UPDATE domains SET status = 'failed' WHERE hostname = $1`, [hostname]);
  }

  json(res, 200, {
    hostname,
    status: state,
    cf_status: hostStatus,
    cf_ssl_status: sslStatus,
    verification_errors: verificationErrors,
    cname_target: `${slug}.western-communication.com`,
    activated_at: row.activated_at,
  });
}

// ── Helpers for activation/deactivation ──────────────────────────────
async function activate(slug, app, hostname) {
  // 1. Patch Coolify app FQDN
  const cf = await coolify.forSlug(slug);
  const cfApp = await cf.get(`/applications/${app.coolify_app_uuid}`);
  const currentFqdn = (cfApp.fqdn || "").trim();
  const list = currentFqdn ? currentFqdn.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const fqdnEntry = `https://${hostname}`;
  if (!list.includes(fqdnEntry)) list.push(fqdnEntry);
  await cf.patch(`/applications/${app.coolify_app_uuid}`, { fqdn: list.join(",") });

  // 2. Add Cloudflare Tunnel ingress entry
  await tunnelIngressAdd(app.tunnel_id, hostname);
}

async function deactivate(slug, app, hostname) {
  // 1. Remove from Coolify FQDN
  try {
    const cf = await coolify.forSlug(slug);
    const cfApp = await cf.get(`/applications/${app.coolify_app_uuid}`);
    const list = (cfApp.fqdn || "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s && s !== `https://${hostname}` && s !== `http://${hostname}`);
    await cf.patch(`/applications/${app.coolify_app_uuid}`, { fqdn: list.join(",") });
  } catch (e) {
    console.error("[domains] coolify fqdn patch on delete failed:", e.message);
  }

  // 2. Remove tunnel ingress entry
  try {
    await tunnelIngressRemove(app.tunnel_id, hostname);
  } catch (e) {
    console.error("[domains] tunnel ingress remove failed:", e.message);
  }
}

async function tunnelIngressAdd(tunnelId, hostname) {
  if (!tunnelId) return;
  const cur = await cfApi("GET", `/accounts/${CF_ACCOUNT_ID}/cfd_tunnel/${tunnelId}/configurations`);
  const ingress = (cur.result && cur.result.config && cur.result.config.ingress) || [];
  if (ingress.some((r) => r.hostname === hostname)) return;
  // Insert just before the catchall (last entry has no hostname)
  const idx = ingress.findIndex((r) => !r.hostname);
  const insertAt = idx >= 0 ? idx : ingress.length;
  const newIngress = [...ingress];
  newIngress.splice(insertAt, 0, { hostname, service: TUNNEL_TARGET });
  await cfApi(
    "PUT",
    `/accounts/${CF_ACCOUNT_ID}/cfd_tunnel/${tunnelId}/configurations`,
    { config: { ingress: newIngress } },
  );
}

async function tunnelIngressRemove(tunnelId, hostname) {
  if (!tunnelId) return;
  const cur = await cfApi("GET", `/accounts/${CF_ACCOUNT_ID}/cfd_tunnel/${tunnelId}/configurations`);
  const ingress = (cur.result && cur.result.config && cur.result.config.ingress) || [];
  const filtered = ingress.filter((r) => r.hostname !== hostname);
  if (filtered.length === ingress.length) return;
  await cfApi(
    "PUT",
    `/accounts/${CF_ACCOUNT_ID}/cfd_tunnel/${tunnelId}/configurations`,
    { config: { ingress: filtered } },
  );
}

// ── 3. DELETE /apps/{id}/domains/{hostname} ──────────────────────────
async function del(req, res, { slug, params }) {
  const app = await appBySlugAndId(slug, params.id);
  if (!app) return bad(res, 404, "app not found", "not_found");
  const hostname = params.hostname.toLowerCase();

  const row = await db.oneJson(
    `SELECT row_to_json(t) FROM (
       SELECT * FROM domains WHERE hostname = $1 AND app_id = $2 AND status != 'deleted'
     ) t`,
    [hostname, app.id],
  );
  if (!row) return bad(res, 404, "domain not found", "not_found");

  await deactivate(slug, app, hostname);

  // Remove from Cloudflare
  try {
    await cfApi("DELETE", `/zones/${CF_ZONE_ID}/custom_hostnames/${row.cf_custom_hostname_id}`);
  } catch (e) {
    console.error("[domains] CF delete failed (continuing):", e.message);
  }

  if (row.dns_integration_id && row.dns_record_id && row.dns_zone_id) {
    try {
      const integ = await dnsIntegrations.getById(slug, row.dns_integration_id);
      if (integ) {
        const client = buildClient(integ.provider, integ.credentials);
        await client.deleteRecord(row.dns_zone_id, row.dns_record_id);
        await audit(req, "domain.dns_autocleanup", slug, `hostname=${hostname} provider=${integ.provider} record=${row.dns_record_id}`);
      }
    } catch (e) {
      console.error("[domains] DNS cleanup failed (continuing):", e.message);
      await audit(req, "domain.dns_autocleanup_failed", slug, `hostname=${hostname} error=${e.message.slice(0, 200)}`);
    }
  }

  await db.exec(
    `UPDATE domains SET status = 'deleted', deleted_at = now() WHERE hostname = $1`,
    [hostname],
  );
  await audit(req, "domain.delete", slug, `app=${app.id} hostname=${hostname}`);
  json(res, 200, { ok: true });
}

module.exports = { add, status, delete: del };
