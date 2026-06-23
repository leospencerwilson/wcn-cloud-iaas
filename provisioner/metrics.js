// Provisioner-side metrics endpoints. Queries Prometheus HTTP API
// running on the coolify VM (http://127.0.0.1:9090) and shapes the
// response for the console UI.
//
// Endpoints:
//   GET /vms/{slug}/metrics?window=1h&series=cpu,ram,disk,net
//   GET /apps/{id}/metrics?window=1h&series=cpu,ram,net

const http = require("http");
const db = require("./db");
const coolify = require("./coolify");

const PROM_URL = process.env.PROMETHEUS_URL || "http://127.0.0.1:9090";

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
function bad(res, code, err, error_code = "bad_request") {
  json(res, code, { error: err, code: error_code });
}

// Windows → range / step
const WINDOWS = {
  "1h":  { seconds: 3600,        step: "30s" },
  "24h": { seconds: 24 * 3600,   step: "5m"  },
  "7d":  { seconds: 7 * 86400,   step: "30m" },
  "30d": { seconds: 30 * 86400,  step: "2h"  },
};

function promRange(query, range, step) {
  const end = Math.floor(Date.now() / 1000);
  const start = end - range;
  const u = new URL(`${PROM_URL}/api/v1/query_range`);
  u.searchParams.set("query", query);
  u.searchParams.set("start", String(start));
  u.searchParams.set("end", String(end));
  u.searchParams.set("step", step);
  return new Promise((resolve, reject) => {
    http
      .get(u.toString(), (r) => {
        let buf = "";
        r.on("data", (c) => (buf += c));
        r.on("end", () => {
          try {
            const parsed = JSON.parse(buf);
            if (parsed.status !== "success") {
              return reject(
                Object.assign(new Error(`prometheus: ${parsed.error || buf.slice(0, 200)}`), { status: 502 }),
              );
            }
            resolve(parsed.data.result);
          } catch (e) {
            reject(Object.assign(new Error(`prometheus non-json: ${buf.slice(0, 200)}`), { status: 502 }));
          }
        });
      })
      .on("error", reject);
  });
}

// Reduce a Prom matrix result (potentially multi-series) to a single
// time-series by summing values per timestamp. Used for net per
// interface, etc.
function sumSeries(result) {
  if (!result || result.length === 0) return [];
  const buckets = new Map();
  for (const series of result) {
    for (const [ts, value] of series.values) {
      const v = parseFloat(value);
      if (Number.isFinite(v)) buckets.set(ts, (buckets.get(ts) || 0) + v);
    }
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ts, value]) => ({ ts, value }));
}

function singleSeries(result) {
  if (!result || result.length === 0) return [];
  return result[0].values
    .map(([ts, v]) => ({ ts, value: parseFloat(v) }))
    .filter((p) => Number.isFinite(p.value));
}

// ── /vms/{slug}/metrics ──────────────────────────────────────────────
async function vmMetrics(req, res, { slug, query }) {
  // VoIP platform hosts are Prometheus targets (slug=voip-*, kind=node), not customer VMs.
  if (!/^voip-(sbc|edge|core)$/.test(slug)) {
    const vm = await db.oneJson(
      `SELECT row_to_json(t) FROM (SELECT customer_slug FROM vms WHERE customer_slug = $1) t`,
      [slug],
    );
    if (!vm) return bad(res, 404, "vm not found", "not_found");
  }

  const winKey = query.window || "1h";
  const win = WINDOWS[winKey];
  if (!win) return bad(res, 400, "invalid window — use 1h|24h|7d|30d", "invalid_window");

  const requested = (query.series || "cpu,ram,disk,net")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const sel = `slug="${slug}",kind="node"`;
  const queries = {
    cpu:    `(1 - avg by (slug) (rate(node_cpu_seconds_total{${sel},mode="idle"}[5m]))) * 100`,
    ram:    `(1 - (node_memory_MemAvailable_bytes{${sel}} / node_memory_MemTotal_bytes{${sel}})) * 100`,
    disk:   `(1 - (node_filesystem_avail_bytes{${sel},mountpoint="/"} / node_filesystem_size_bytes{${sel},mountpoint="/"})) * 100`,
    net_in: `sum by (slug) (rate(node_network_receive_bytes_total{${sel},device!="lo"}[5m]))`,
    net_out:`sum by (slug) (rate(node_network_transmit_bytes_total{${sel},device!="lo"}[5m]))`,
  };

  const out = {};
  for (const series of requested) {
    if (series === "net") {
      out.net_in = singleSeries(await promRange(queries.net_in, win.seconds, win.step));
      out.net_out = singleSeries(await promRange(queries.net_out, win.seconds, win.step));
    } else if (queries[series]) {
      out[series] = singleSeries(await promRange(queries[series], win.seconds, win.step));
    }
  }

  json(res, 200, { slug, window: winKey, step: win.step, series: out });
}

// ── /apps/{id}/metrics ───────────────────────────────────────────────
async function appMetrics(req, res, { slug, params, query }) {
  const app = await db.oneJson(
    `SELECT row_to_json(t) FROM (
       SELECT id, name, coolify_app_uuid FROM apps WHERE customer_slug = $1 AND id = $2
     ) t`,
    [slug, params.id],
  );
  if (!app) return bad(res, 404, "app not found", "not_found");

  const winKey = query.window || "1h";
  const win = WINDOWS[winKey];
  if (!win) return bad(res, 400, "invalid window — use 1h|24h|7d|30d", "invalid_window");

  // Coolify names application containers `<coolify_app_uuid>-<deployment_id>`.
  // Match by the uuid prefix so we pick up the current container regardless of
  // which deployment id it ended up with. (The Coolify API doesn't reliably
  // return a container_name field, so the old `${name}-${uuid}` fallback was
  // wrong — that wasn't the actual docker container name.)
  const uuidEscaped = app.coolify_app_uuid.replace(/[.+*?^$()[\]{}|\\]/g, "\\$&");
  const containerName = app.coolify_app_uuid;
  const sel = `slug="${slug}",kind="cadvisor",name=~"^${uuidEscaped}(-.*)?$"`;

  const queries = {
    cpu:     `sum(rate(container_cpu_usage_seconds_total{${sel}}[5m])) * 100`,
    ram:     `sum(container_memory_usage_bytes{${sel}})`,
    ram_pct: `(sum(container_memory_usage_bytes{${sel}}) / sum(container_spec_memory_limit_bytes{${sel}}) > 0) * 100`,
    net_in:  `sum(rate(container_network_receive_bytes_total{${sel}}[5m]))`,
    net_out: `sum(rate(container_network_transmit_bytes_total{${sel}}[5m]))`,
  };

  const requested = (query.series || "cpu,ram,net")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const out = {};
  for (const series of requested) {
    if (series === "net") {
      out.net_in = singleSeries(await promRange(queries.net_in, win.seconds, win.step));
      out.net_out = singleSeries(await promRange(queries.net_out, win.seconds, win.step));
    } else if (queries[series]) {
      out[series] = singleSeries(await promRange(queries[series], win.seconds, win.step));
    }
  }

  json(res, 200, {
    slug,
    app_id: app.id,
    container: containerName,
    window: winKey,
    step: win.step,
    series: out,
  });
}

module.exports = { vmMetrics, appMetrics };
