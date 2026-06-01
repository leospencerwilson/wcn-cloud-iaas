// Public per-customer status endpoint. No auth — intentionally exposes
// only operational health, never internal identifiers (no IPs, no VMIDs,
// no container names).
//
//   GET /public/status/{slug}
//
// Cached in-memory for 30s to absorb burst traffic without hitting
// Proxmox + Prometheus on every request.

const https = require("https");
const http = require("http");
const db = require("./db");

const PROXMOX_HOST = process.env.PROXMOX_HOST;
const PROXMOX_TOKEN = process.env.PROXMOX_API_TOKEN;
const PROM_URL = process.env.PROMETHEUS_URL || "http://127.0.0.1:9090";
const CACHE_TTL_MS = 30_000;

const cache = new Map(); // slug → { at, body }

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "public, max-age=30" });
  res.end(JSON.stringify(body));
}

function pveGet(apiPath) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: PROXMOX_HOST,
      port: 8006,
      path: `/api2/json${apiPath}`,
      method: "GET",
      rejectUnauthorized: false,
      headers: { Authorization: `PVEAPIToken=${PROXMOX_TOKEN}` },
    }, (r) => {
      let buf = "";
      r.on("data", (c) => (buf += c));
      r.on("end", () => {
        try {
          const parsed = JSON.parse(buf);
          if (r.statusCode >= 400) return reject(new Error(`proxmox ${r.statusCode}`));
          resolve(parsed.data);
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function promInstant(query) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${PROM_URL}/api/v1/query`);
    u.searchParams.set("query", query);
    http.get(u.toString(), (r) => {
      let buf = "";
      r.on("data", (c) => (buf += c));
      r.on("end", () => {
        try {
          const parsed = JSON.parse(buf);
          if (parsed.status !== "success") return reject(new Error(parsed.error || "prom error"));
          const result = parsed.data.result;
          if (!result || result.length === 0) return resolve(null);
          resolve(parseFloat(result[0].value[1]));
        } catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

async function compute(slug) {
  const customer = await db.oneJson(
    `SELECT row_to_json(t) FROM (SELECT name, slug FROM customers WHERE slug = $1) t`,
    [slug],
  );
  if (!customer) return null;

  const vm = await db.oneJson(
    `SELECT row_to_json(t) FROM (SELECT vmid, proxmox_node, created_at FROM vms WHERE customer_slug = $1) t`,
    [slug],
  );

  // VM power
  let vmStatus = "unknown";
  if (vm) {
    try {
      const data = await pveGet(`/nodes/${vm.proxmox_node}/qemu/${vm.vmid}/status/current`);
      vmStatus = data.status === "running" ? "operational" : "down";
    } catch {
      vmStatus = "unknown";
    }
  }

  // Apps
  const apps = await db.rowsJson(
    `SELECT row_to_json(t) FROM (
       SELECT name, status FROM apps WHERE customer_slug = $1 ORDER BY name
     ) t`,
    [slug],
  );

  // Uptime stats
  const uptime = {};
  for (const [key, range] of [["h24", "24h"], ["d30", "30d"], ["d90", "90d"]]) {
    try {
      const v = await promInstant(`avg_over_time(up{slug="${slug}",kind="node"}[${range}]) * 100`);
      uptime[key] = v != null ? Math.round(v * 100) / 100 : null;
    } catch {
      uptime[key] = null;
    }
  }

  // Overall health
  const appsList = apps.map((a) => {
    let s = "operational";
    if (a.status === "stopped") s = "stopped";
    else if (a.status === "failed") s = "down";
    else if (a.status === "building") s = "degraded";
    return { name: a.name, status: s };
  });
  let overall = "operational";
  if (vmStatus !== "operational") overall = vmStatus === "unknown" ? "degraded" : "down";
  else if (appsList.some((a) => a.status === "down")) overall = "degraded";

  return {
    customer: { name: customer.name, slug: customer.slug },
    overall,
    services: [
      { name: "Compute", status: vmStatus },
      ...appsList,
    ],
    uptime,
    incidents: [],
    checked_at: new Date().toISOString(),
  };
}

async function publicStatus(req, res, { slug }) {
  const cached = cache.get(slug);
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) {
    return json(res, 200, cached.body);
  }
  let body;
  try {
    body = await compute(slug);
  } catch (e) {
    // Fall back to last good cached value if available
    if (cached) return json(res, 200, { ...cached.body, stale: true });
    return json(res, 502, { error: e.message, code: "compute_failed" });
  }
  if (!body) {
    return json(res, 404, { error: "customer not found", code: "not_found" });
  }
  cache.set(slug, { at: now, body });
  return json(res, 200, body);
}

module.exports = { publicStatus };
