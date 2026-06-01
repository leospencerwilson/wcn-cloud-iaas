// Provisioner alerting endpoints. Receives Alertmanager webhooks,
// stores firings, surfaces them for the admin UI.

const http = require("http");
const db = require("./db");

const PROM_URL = process.env.PROMETHEUS_URL || "http://127.0.0.1:9090";

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
function bad(res, code, err, error_code = "bad_request") {
  json(res, code, { error: err, code: error_code });
}

// ── POST /alerts/webhook  (Alertmanager → provisioner) ──────────────
async function webhook(req, res, { body }) {
  const alerts = Array.isArray(body && body.alerts) ? body.alerts : [];
  if (alerts.length === 0) return json(res, 200, { ok: true, ingested: 0 });

  for (const a of alerts) {
    const fp = a.fingerprint || "";
    if (!fp) continue;
    const labels = a.labels || {};
    const annotations = a.annotations || {};
    try {
      await db.exec(
        `INSERT INTO alert_firings
           (fingerprint, alertname, severity, slug, summary, status, started_at, resolved_at, raw)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
         ON CONFLICT (fingerprint) DO UPDATE SET
           status      = EXCLUDED.status,
           resolved_at = EXCLUDED.resolved_at,
           summary     = EXCLUDED.summary,
           raw         = EXCLUDED.raw,
           received_at = now()`,
        [
          fp,
          labels.alertname || "unknown",
          labels.severity || null,
          labels.slug || null,
          annotations.summary || annotations.description || null,
          a.status === "resolved" ? "resolved" : "firing",
          a.startsAt || new Date().toISOString(),
          a.status === "resolved" ? (a.endsAt || new Date().toISOString()) : null,
          JSON.stringify(a),
        ],
      );
    } catch (e) {
      console.error("[alerts] firing insert failed:", e.message);
    }
  }
  json(res, 200, { ok: true, ingested: alerts.length });
}

// ── GET /alerts/firings?since=&status=&slug= ────────────────────────
async function listFirings(req, res, { query }) {
  const filters = [];
  const params = [];
  let i = 0;

  if (query.since) {
    const d = new Date(query.since);
    if (Number.isNaN(d.getTime())) return bad(res, 400, "invalid since", "invalid_since");
    filters.push(`started_at >= $${++i}`); params.push(d.toISOString());
  }
  if (query.status) {
    if (!["firing", "resolved"].includes(query.status)) {
      return bad(res, 400, "status must be firing|resolved", "invalid_status");
    }
    filters.push(`status = $${++i}`); params.push(query.status);
  }
  if (query.slug) {
    filters.push(`slug = $${++i}`); params.push(query.slug);
  }

  const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
  const limit = Math.min(parseInt(query.limit || "100", 10) || 100, 500);

  const rows = await db.rowsJson(
    `SELECT row_to_json(t) FROM (
       SELECT id, fingerprint, alertname, severity, slug, summary, status,
              started_at, resolved_at, received_at
       FROM alert_firings ${where}
       ORDER BY started_at DESC LIMIT ${limit}
     ) t`,
    params,
  );
  json(res, 200, rows);
}

// ── GET /alerts/rules — list of configured alert rules ──────────────
function promGet(apiPath) {
  return new Promise((resolve, reject) => {
    http.get(`${PROM_URL}${apiPath}`, (r) => {
      let buf = "";
      r.on("data", (c) => (buf += c));
      r.on("end", () => {
        try { resolve(JSON.parse(buf)); } catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

async function listRules(req, res) {
  let data;
  try {
    data = await promGet("/api/v1/rules");
  } catch (e) {
    return bad(res, 502, `prometheus: ${e.message}`, "prom_error");
  }
  const rules = [];
  for (const g of (data.data && data.data.groups) || []) {
    for (const r of g.rules || []) {
      if (r.type === "alerting") {
        rules.push({
          name: r.name,
          state: r.state,
          health: r.health,
          severity: (r.labels && r.labels.severity) || null,
          duration_s: r.duration,
          query: r.query,
          summary: (r.annotations && r.annotations.summary) || null,
          firing_count: (r.alerts || []).filter((a) => a.state === "firing").length,
        });
      }
    }
  }
  json(res, 200, rules);
}

module.exports = { webhook, listFirings, listRules };
