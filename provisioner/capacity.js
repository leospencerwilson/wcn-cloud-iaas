// T3 #29 — Capacity planning. Per-node and aggregate.
// GET /admin/capacity

const https = require("https");
const db = require("./db");

const PROXMOX_HOST = process.env.PROXMOX_HOST;
const PROXMOX_TOKEN = process.env.PROXMOX_API_TOKEN;

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function pveGet(apiPath) {
  return new Promise((resolve, reject) => {
    https.request({
      hostname: PROXMOX_HOST, port: 8006,
      path: `/api2/json${apiPath}`, method: "GET",
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
    }).on("error", reject).end();
  });
}

// Per-tier baseline allocations (used for "fits N more" projections).
// These reflect what provision-customer.sh requests at clone time.
const TIER_SHAPES = {
  small:  { cores: 2, memory_mb: 4096,  disk_gb: 40  },
  medium: { cores: 4, memory_mb: 8192,  disk_gb: 80  },
  large:  { cores: 8, memory_mb: 16384, disk_gb: 160 },
};

async function get(req, res) {
  let nodes;
  try {
    nodes = await pveGet("/nodes");
  } catch (e) {
    return json(res, 502, { error: `proxmox: ${e.message}`, code: "proxmox_error" });
  }

  // Per-node stats: hit /nodes/{node}/status for memory/CPU,
  // /nodes/{node}/storage for disk
  const perNode = [];
  for (const n of nodes || []) {
    const nodeOut = {
      node: n.node,
      status: n.status,
      cpu_used_frac: n.cpu || 0,
      cpu_cores: n.maxcpu || 0,
      mem_used_bytes: n.mem || 0,
      mem_total_bytes: n.maxmem || 0,
      uptime_seconds: n.uptime || 0,
      storage: [],
      running_vms: 0,
      stopped_vms: 0,
    };

    try {
      const storages = await pveGet(`/nodes/${n.node}/storage`);
      for (const s of storages || []) {
        if (!s.active) continue;
        nodeOut.storage.push({
          name: s.storage,
          type: s.type,
          used_bytes: s.used || 0,
          total_bytes: s.total || 0,
          avail_bytes: s.avail || 0,
        });
      }
      const vms = await pveGet(`/nodes/${n.node}/qemu`);
      for (const v of vms || []) {
        if (v.vmid >= 200 && v.vmid <= 399) {
          (v.status === "running" ? nodeOut.running_vms : nodeOut.stopped_vms === 0 ? 0 : 0);
          if (v.status === "running") nodeOut.running_vms++;
          else nodeOut.stopped_vms++;
        }
      }
    } catch (e) {
      // partial data is fine
    }

    // Headroom calculation: use the primary storage (largest by total).
    const primary = nodeOut.storage.slice().sort((a, b) => b.total_bytes - a.total_bytes)[0];
    const freeMemBytes = nodeOut.mem_total_bytes - nodeOut.mem_used_bytes;
    const freeCores = nodeOut.cpu_cores * (1 - nodeOut.cpu_used_frac);
    const freeDiskBytes = primary ? primary.avail_bytes : 0;

    // Project "fits N more of each tier" — limited by whichever resource runs out first.
    nodeOut.projection = {};
    for (const [tier, shape] of Object.entries(TIER_SHAPES)) {
      const byMem  = Math.floor(freeMemBytes  / (shape.memory_mb * 1024 * 1024));
      const byCpu  = Math.floor(freeCores     / shape.cores);
      const byDisk = Math.floor(freeDiskBytes / (shape.disk_gb * 1024 * 1024 * 1024));
      nodeOut.projection[tier] = {
        fits: Math.max(0, Math.min(byMem, byCpu, byDisk)),
        limited_by: byMem <= byCpu && byMem <= byDisk ? "memory"
                  : byCpu <= byDisk ? "cpu" : "disk",
      };
    }
    nodeOut.pressure = {
      memory: nodeOut.mem_total_bytes > 0 ? nodeOut.mem_used_bytes / nodeOut.mem_total_bytes : 0,
      cpu: nodeOut.cpu_used_frac,
      disk: primary && primary.total_bytes > 0 ? primary.used_bytes / primary.total_bytes : 0,
    };

    perNode.push(nodeOut);
  }

  // Aggregate customer counts from ops_db
  const customerCounts = await db.rowsJson(
    `SELECT row_to_json(t) FROM (
       SELECT COALESCE(tier, 'unknown') AS tier, COUNT(*) AS count
       FROM customers WHERE status != 'destroyed'
       GROUP BY tier
     ) t`,
  );

  json(res, 200, {
    nodes: perNode,
    aggregate: {
      total_running: perNode.reduce((s, n) => s + n.running_vms, 0),
      total_stopped: perNode.reduce((s, n) => s + n.stopped_vms, 0),
      total_capacity_fits: Object.fromEntries(
        Object.keys(TIER_SHAPES).map((t) => [t, perNode.reduce((s, n) => s + (n.projection?.[t]?.fits || 0), 0)]),
      ),
    },
    customer_counts: customerCounts,
    tier_shapes: TIER_SHAPES,
    checked_at: new Date().toISOString(),
  });
}

module.exports = { get };
