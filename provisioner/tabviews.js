// Aggregated views for the dashboard's Supabase + Coolify tabs.
// These compose existing data — most are simple DB queries + a few
// per-app Coolify calls.

const db = require("./db");
const coolify = require("./coolify");

const WCN_BASE_DOMAIN = process.env.WCN_BASE_DOMAIN || "western-communication.com";

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
function bad(res, code, err, error_code = "bad_request") {
  json(res, code, { error: err, code: error_code });
}

async function vmBySlug(slug) {
  return db.oneJson(
    `SELECT row_to_json(t) FROM (
       SELECT customer_slug, vmid, host(ip)::text AS ip, db_password
       FROM vms WHERE customer_slug = $1
     ) t`,
    [slug],
  );
}

// ── GET /vms/{slug}/supabase/connection ─────────────────────────────
async function supabaseConnection(req, res, { slug }) {
  const vm = await vmBySlug(slug);
  if (!vm) return bad(res, 404, "vm not found", "not_found");

  const pw = vm.db_password || null;
  const enc = pw ? encodeURIComponent(pw) : "[your-password]";

  json(res, 200, {
    studio_url:      `https://db-${slug}.${WCN_BASE_DOMAIN}`,
    rest_url:        `https://api-${slug}.${WCN_BASE_DOMAIN}`,
    realtime_url:    `wss://api-${slug}.${WCN_BASE_DOMAIN}/realtime/v1`,
    storage_url:     `https://api-${slug}.${WCN_BASE_DOMAIN}/storage/v1`,
    auth_url:        `https://api-${slug}.${WCN_BASE_DOMAIN}/auth/v1`,
    connection_strings: {
      direct_external:  `postgresql://postgres:${enc}@db-${slug}.${WCN_BASE_DOMAIN}:5432/postgres`,
      pooler_session:   `postgresql://postgres:${enc}@db-${slug}.${WCN_BASE_DOMAIN}:5432/postgres`,
      pooler_transaction: `postgresql://postgres:${enc}@db-${slug}.${WCN_BASE_DOMAIN}:6543/postgres`,
      direct_internal:  `postgresql://postgres:${enc}@${vm.ip}:5432/postgres`,
    },
    password_known: !!pw,
    note: pw
      ? null
      : "Database password is not stored in ops_db for this customer. Show '[your-password]' as a placeholder and link to the password reset flow.",
  });
}

// ── GET /vms/{slug}/coolify/webhooks ────────────────────────────────
// All apps + their webhook config in one go. Pure DB read.
async function webhooksOverview(req, res, { slug }) {
  const rows = await db.rowsJson(
    `SELECT row_to_json(t) FROM (
       SELECT id, name, coolify_app_uuid, status,
         github_webhook_id, github_webhook_id IS NOT NULL AS configured,
         github_branch, github_enabled, github_last_delivery_at
       FROM apps WHERE customer_slug = $1 ORDER BY name
     ) t`,
    [slug],
  );
  json(res, 200, rows.map((a) => ({
    app_id: a.id,
    app_name: a.name,
    app_status: a.status,
    webhook: {
      configured: !!a.configured,
      webhook_id: a.github_webhook_id,
      webhook_url: a.github_webhook_id
        ? `https://console.western-communication.com/api/webhooks/github/${a.github_webhook_id}`
        : null,
      branch: a.github_branch,
      enabled: a.github_enabled,
      last_delivery_at: a.github_last_delivery_at,
    },
  })));
}

// ── GET /vms/{slug}/coolify/env ─────────────────────────────────────
// Flat list of env vars across all apps. Values masked.
async function envOverview(req, res, { slug }) {
  const rows = await db.rowsJson(
    `SELECT row_to_json(t) FROM (
       SELECT a.id AS app_id, a.name AS app_name,
              v.key, v.is_build_time, v.is_preview
       FROM apps a
       LEFT JOIN app_env_vars v ON v.app_id = a.id
       WHERE a.customer_slug = $1
       ORDER BY a.name, v.key
     ) t`,
    [slug],
  );

  // Group by app
  const byApp = new Map();
  for (const r of rows) {
    if (!byApp.has(r.app_id)) {
      byApp.set(r.app_id, { app_id: r.app_id, app_name: r.app_name, env_vars: [] });
    }
    if (r.key) {
      byApp.get(r.app_id).env_vars.push({
        key: r.key,
        is_build_time: r.is_build_time,
        is_preview: r.is_preview,
      });
    }
  }
  json(res, 200, [...byApp.values()]);
}

// ── GET /vms/{slug}/coolify/cron ────────────────────────────────────
// Aggregate cron tasks across all apps. Calls Coolify in parallel.
async function cronOverview(req, res, { slug }) {
  const apps = await db.rowsJson(
    `SELECT row_to_json(t) FROM (
       SELECT id, name, coolify_app_uuid FROM apps
       WHERE customer_slug = $1 AND coolify_app_uuid IS NOT NULL
       ORDER BY name
     ) t`,
    [slug],
  );

  let cf;
  try {
    cf = await coolify.forSlug(slug);
  } catch (e) {
    return bad(res, 502, `coolify: ${e.message}`, "coolify_error");
  }

  const results = await Promise.all(apps.map(async (a) => {
    let tasks = [];
    let error = null;
    try {
      const list = await cf.get(`/applications/${a.coolify_app_uuid}/scheduled-tasks`);
      tasks = Array.isArray(list) ? list : [];
    } catch (e) {
      error = e.message;
    }
    return { app_id: a.id, app_name: a.name, tasks, error };
  }));
  json(res, 200, results);
}

module.exports = { supabaseConnection, webhooksOverview, envOverview, cronOverview };
