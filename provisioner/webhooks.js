// Push-to-deploy: per-app GitHub webhook config + console-side
// verification helper. The console exposes the public webhook
// endpoint; this module just stores the config and resolves
// webhook_id → secret for HMAC validation.

const crypto = require("crypto");
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
  } catch (e) { console.error("[webhooks] audit failed:", e.message); }
}

async function appBySlugAndId(slug, id) {
  return db.oneJson(
    `SELECT row_to_json(t) FROM (
       SELECT id, customer_slug, name, coolify_app_uuid,
              github_webhook_id, github_branch, github_enabled, github_last_delivery_at
       FROM apps WHERE customer_slug = $1 AND id = $2
     ) t`,
    [slug, id],
  );
}

// POST /apps/{id}/webhook { branch? }
async function create(req, res, { slug, params, body }) {
  const app = await appBySlugAndId(slug, params.id);
  if (!app) return bad(res, 404, "app not found", "not_found");
  const branch = (body && body.branch) || "main";
  if (!/^[A-Za-z0-9._\/-]{1,100}$/.test(branch)) return bad(res, 400, "invalid branch", "invalid_branch");

  const webhookId = crypto.randomUUID();
  const secret = crypto.randomBytes(24).toString("hex");

  await db.exec(
    `UPDATE apps SET
       github_webhook_id = $2,
       github_webhook_secret = $3,
       github_branch = $4,
       github_enabled = true
     WHERE id = $1`,
    [app.id, webhookId, secret, branch],
  );
  await audit(req, "app.webhook.create", slug, `app=${app.id} branch=${branch}`);

  json(res, 201, {
    webhook_id: webhookId,
    secret,                     // shown once
    branch,
    enabled: true,
    instructions: `Add a webhook in your GitHub repo settings: URL = https://console.western-communication.com/api/webhooks/github/${webhookId}, Content type = application/json, Secret = (paste the secret above), Events = "Just the push event".`,
    message: "Save the secret now — it will not be shown again.",
  });
}

// GET /apps/{id}/webhook
async function get(req, res, { slug, params }) {
  const app = await appBySlugAndId(slug, params.id);
  if (!app) return bad(res, 404, "app not found", "not_found");
  if (!app.github_webhook_id) return json(res, 200, { configured: false });
  json(res, 200, {
    configured: true,
    webhook_id: app.github_webhook_id,
    webhook_url: `https://console.western-communication.com/api/webhooks/github/${app.github_webhook_id}`,
    branch: app.github_branch,
    enabled: app.github_enabled,
    last_delivery_at: app.github_last_delivery_at,
  });
}

// PATCH /apps/{id}/webhook { branch?, enabled? }
async function update(req, res, { slug, params, body }) {
  const app = await appBySlugAndId(slug, params.id);
  if (!app) return bad(res, 404, "app not found", "not_found");
  if (!app.github_webhook_id) return bad(res, 404, "no webhook configured", "not_configured");

  const sets = [];
  const vals = [];
  let i = 1;
  if (body.branch !== undefined) {
    if (!/^[A-Za-z0-9._\/-]{1,100}$/.test(body.branch)) return bad(res, 400, "invalid branch", "invalid_branch");
    sets.push(`github_branch = $${++i}`); vals.push(body.branch);
  }
  if (body.enabled !== undefined) {
    sets.push(`github_enabled = $${++i}`); vals.push(!!body.enabled);
  }
  if (sets.length === 0) return bad(res, 400, "no changes", "no_changes");

  await db.exec(`UPDATE apps SET ${sets.join(", ")} WHERE id = $1`, [app.id, ...vals]);
  await audit(req, "app.webhook.update", slug, `app=${app.id} changes=${JSON.stringify(body)}`);
  json(res, 200, { ok: true });
}

// DELETE /apps/{id}/webhook
async function del(req, res, { slug, params }) {
  const app = await appBySlugAndId(slug, params.id);
  if (!app) return bad(res, 404, "app not found", "not_found");
  await db.exec(
    `UPDATE apps SET github_webhook_id = NULL, github_webhook_secret = NULL,
                     github_enabled = false WHERE id = $1`,
    [app.id],
  );
  await audit(req, "app.webhook.delete", slug, `app=${app.id}`);
  json(res, 200, { ok: true });
}

// POST /webhooks/github/lookup { webhook_id }
// Used by the console to resolve a webhook to its secret for HMAC
// verification. Returns the *raw* secret — only the console (which
// holds the master bearer token) can call this.
async function lookup(req, res, { body }) {
  const wid = body && body.webhook_id;
  if (!wid || !/^[0-9a-f-]{36}$/i.test(wid)) return bad(res, 400, "invalid webhook_id", "invalid_id");
  const row = await db.oneJson(
    `SELECT row_to_json(t) FROM (
       SELECT id, customer_slug, coolify_app_uuid,
              github_webhook_secret, github_branch, github_enabled
       FROM apps WHERE github_webhook_id = $1
     ) t`,
    [wid],
  );
  if (!row) return bad(res, 404, "webhook not found", "not_found");
  if (!row.github_enabled) return bad(res, 410, "webhook disabled", "disabled");
  json(res, 200, {
    app_id: row.id,
    customer_slug: row.customer_slug,
    coolify_app_uuid: row.coolify_app_uuid,
    secret: row.github_webhook_secret,
    branch: row.github_branch,
  });
}

// POST /webhooks/github/delivered { app_id }
// Console pings this after a successful deploy trigger so we can show
// "last delivery" in the UI.
async function delivered(req, res, { body }) {
  const id = body && body.app_id;
  if (!id) return bad(res, 400, "app_id required", "missing_id");
  await db.exec(`UPDATE apps SET github_last_delivery_at = now() WHERE id = $1`, [id]);
  json(res, 200, { ok: true });
}

module.exports = { create, get, update, delete: del, lookup, delivered };
