// HTTP handlers for /vms/{slug}/* endpoints (T1: power control + backup).
// Server.js dispatches here after auth + slug validation.

const https = require("https");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const db = require("./db");

const PROXMOX_HOST = process.env.PROXMOX_HOST;
const PROXMOX_TOKEN = process.env.PROXMOX_API_TOKEN;
const SCRIPTS_DIR = process.env.SCRIPTS_DIR || "/opt/wcn-cloud/scripts";
const LOG_DIR = process.env.LOG_DIR || "/var/log/wcn-cloud/jobs";

if (!PROXMOX_HOST || !PROXMOX_TOKEN) {
  console.error("[vms] PROXMOX_HOST / PROXMOX_API_TOKEN missing — /vms endpoints will fail");
}

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
       SELECT vmid, customer_slug, proxmox_node, ip, status
       FROM vms WHERE customer_slug = $1
     ) t`,
    [slug],
  );
}

function pveApi(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? new URLSearchParams(body).toString() : null;
    const req = https.request(
      {
        hostname: PROXMOX_HOST,
        port: 8006,
        path: `/api2/json${apiPath}`,
        method,
        rejectUnauthorized: false,
        headers: {
          Authorization: `PVEAPIToken=${PROXMOX_TOKEN}`,
          ...(data
            ? {
                "Content-Type": "application/x-www-form-urlencoded",
                "Content-Length": Buffer.byteLength(data),
              }
            : {}),
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          if (res.statusCode >= 400) {
            return reject(
              Object.assign(new Error(`proxmox ${res.statusCode}: ${buf}`), { status: 502 }),
            );
          }
          try {
            const parsed = JSON.parse(buf);
            resolve(parsed.data);
          } catch (e) {
            reject(new Error(`proxmox non-json response: ${buf.slice(0, 200)}`));
          }
        });
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function actor(req) {
  return (req.headers["x-wcn-actor"] || "system").toString().slice(0, 120);
}

async function audit(req, action, slug, details = "") {
  try {
    await db.exec(
      `INSERT INTO audit_log (actor, action, slug, details) VALUES ($1, $2, $3, $4)`,
      [actor(req), action, slug, details],
    );
  } catch (e) {
    console.error("[vms] audit insert failed:", e.message);
  }
}

// ── GET /vms/{slug}/power ─────────────────────────────────────────────
async function power(req, res, { slug }) {
  const vm = await vmBySlug(slug);
  if (!vm) return bad(res, 404, "vm not found", "not_found");
  const data = await pveApi("GET", `/nodes/${vm.proxmox_node}/qemu/${vm.vmid}/status/current`);
  json(res, 200, {
    state: data.status,
    qmpstatus: data.qmpstatus,
    uptime: data.uptime || 0,
    cpu: data.cpu || 0,
    cpus: data.cpus,
    mem: data.mem || 0,
    maxmem: data.maxmem || 0,
    disk: data.disk || 0,
    maxdisk: data.maxdisk || 0,
    proxmox_node: vm.proxmox_node,
    vmid: vm.vmid,
  });
}

async function powerAction(action, friendly, req, res, { slug }) {
  const vm = await vmBySlug(slug);
  if (!vm) return bad(res, 404, "vm not found", "not_found");
  const upid = await pveApi("POST", `/nodes/${vm.proxmox_node}/qemu/${vm.vmid}/status/${action}`);
  await audit(req, `vm.${friendly}`, slug, `vmid=${vm.vmid} upid=${upid}`);
  json(res, 202, { upid, vmid: vm.vmid, action: friendly });
}

const restart = (req, res, ctx) => powerAction("reboot", "restart", req, res, ctx);
const stop = (req, res, ctx) => powerAction("shutdown", "stop", req, res, ctx);
const start = (req, res, ctx) => powerAction("start", "start", req, res, ctx);

// ── Backups (T1) ──────────────────────────────────────────────────────
// Wraps scripts/backup-customer.sh as a background job. Returns the job
// uuid immediately; client polls /jobs/{uuid} for status. New rows
// recorded in backups table at job start + finish.

async function listBackups(req, res, { slug }) {
  const vm = await vmBySlug(slug);
  if (!vm) return bad(res, 404, "vm not found", "not_found");
  const rows = await db.rowsJson(
    `SELECT row_to_json(t) FROM (
       SELECT id, started_at, finished_at, size_bytes, status, b2_key
       FROM backups WHERE customer_slug = $1 ORDER BY started_at DESC LIMIT 50
     ) t`,
    [slug],
  );
  json(res, 200, rows);
}

async function createBackup(req, res, { slug, jobs, randomUUID }) {
  const vm = await vmBySlug(slug);
  if (!vm) return bad(res, 404, "vm not found", "not_found");

  const jobId = randomUUID();
  const logPath = path.join(LOG_DIR, `${jobId}.log`);
  const job = {
    jobId,
    kind: "backup",
    slug,
    args: [],
    status: "queued",
    exitCode: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    logPath,
    proc: null,
  };
  jobs.set(jobId, job);

  await audit(req, "vm.backup.start", slug, `job=${jobId}`);

  const scriptPath = path.join(SCRIPTS_DIR, "backup-supabase.sh");
  if (!fs.existsSync(scriptPath)) {
    job.status = "failed";
    job.exitCode = 127;
    job.finishedAt = new Date().toISOString();
    fs.writeFileSync(logPath, `[receiver] ${scriptPath} not found\n`);
    return bad(res, 500, "backup script missing", "missing_script");
  }

  const stream = fs.createWriteStream(logPath, { flags: "a" });
  stream.write(`── ${job.startedAt} — backup ${slug} — job ${jobId}\n\n`);
  job.status = "running";

  const proc = spawn(scriptPath, ["--slug", slug], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  job.proc = proc;
  proc.stdout.on("data", (c) => stream.write(c));
  proc.stderr.on("data", (c) => stream.write(c));
  proc.on("close", async (code) => {
    job.status = code === 0 ? "succeeded" : "failed";
    job.exitCode = code;
    job.finishedAt = new Date().toISOString();
    stream.end(`\n── exit ${code} at ${job.finishedAt}\n`);
    job.proc = null;
    try {
      await db.exec(
        `INSERT INTO backups (customer_slug, started_at, finished_at, status, log_path)
         VALUES ($1, $2, $3, $4, $5)`,
        [slug, job.startedAt, job.finishedAt, job.status, logPath],
      );
    } catch (e) {
      console.error("[vms] backup row insert failed:", e.message);
    }
  });

  json(res, 202, { job_uuid: jobId, status: job.status });
}


// ── Resize VM ────────────────────────────────────────────────────────
async function resize(req, res, { slug, body }) {
  const vm = await vmBySlug(slug);
  if (!vm) return bad(res, 404, "vm not found", "not_found");

  const params = {};
  if (body.cores) {
    const c = parseInt(body.cores, 10);
    if (!Number.isInteger(c) || c < 1 || c > 32) return bad(res, 400, "cores must be 1–32", "invalid_cores");
    params.cores = c;
  }
  if (body.memory_mb) {
    const m = parseInt(body.memory_mb, 10);
    if (!Number.isInteger(m) || m < 512 || m > 65536) return bad(res, 400, "memory_mb must be 512–65536", "invalid_memory");
    params.memory = m;
  }
  if (Object.keys(params).length === 0 && !body.disk_gb) {
    return bad(res, 400, "supply at least one of cores, memory_mb, disk_gb", "no_changes");
  }

  let configResult, diskResult;
  if (Object.keys(params).length > 0) {
    configResult = await pveApi("POST", `/nodes/${vm.proxmox_node}/qemu/${vm.vmid}/config`, params);
  }
  if (body.disk_gb) {
    const g = parseInt(body.disk_gb, 10);
    if (!Number.isInteger(g) || g < 10 || g > 2000) return bad(res, 400, "disk_gb must be 10–2000", "invalid_disk");
    diskResult = await pveApi("PUT", `/nodes/${vm.proxmox_node}/qemu/${vm.vmid}/resize`, {
      disk: "scsi0",
      size: `${g}G`,
    });
  }

  await audit(req, "vm.resize", slug, `vmid=${vm.vmid} ${JSON.stringify({ ...params, disk_gb: body.disk_gb })}`);
  json(res, 200, {
    ok: true,
    applied: { ...params, disk_gb: body.disk_gb || null },
    config_task: configResult,
    disk_task: diskResult,
  });
}

// ── Snapshots ────────────────────────────────────────────────────────
function snapNameOk(s) { return typeof s === "string" && /^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/.test(s); }

async function listSnapshots(req, res, { slug }) {
  const vm = await vmBySlug(slug);
  if (!vm) return bad(res, 404, "vm not found", "not_found");
  const data = await pveApi("GET", `/nodes/${vm.proxmox_node}/qemu/${vm.vmid}/snapshot`);
  // Proxmox returns the "current" pseudo-snapshot; filter it out.
  const list = (data || []).filter((s) => s.name !== "current").map((s) => ({
    name: s.name,
    description: s.description || null,
    parent: s.parent || null,
    snaptime: s.snaptime,
    vmstate: !!s.vmstate,
  }));
  json(res, 200, list);
}

async function createSnapshot(req, res, { slug, body }) {
  const vm = await vmBySlug(slug);
  if (!vm) return bad(res, 404, "vm not found", "not_found");
  const name = String(body.name || "").trim();
  if (!snapNameOk(name)) return bad(res, 400, "snapshot name must match [A-Za-z][A-Za-z0-9_-]{0,39}", "invalid_name");

  const upid = await pveApi("POST", `/nodes/${vm.proxmox_node}/qemu/${vm.vmid}/snapshot`, {
    snapname: name,
    description: body.label || "",
  });
  await db.exec(
    `INSERT INTO snapshots (customer_slug, vmid, proxmox_name, label)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (vmid, proxmox_name) DO UPDATE SET label = EXCLUDED.label`,
    [slug, vm.vmid, name, body.label || null],
  );
  await audit(req, "vm.snapshot.create", slug, `vmid=${vm.vmid} name=${name}`);
  json(res, 202, { upid, vmid: vm.vmid, name });
}

async function revertSnapshot(req, res, { slug, params }) {
  const vm = await vmBySlug(slug);
  if (!vm) return bad(res, 404, "vm not found", "not_found");
  if (!snapNameOk(params.name)) return bad(res, 400, "invalid snapshot name", "invalid_name");
  const upid = await pveApi("POST", `/nodes/${vm.proxmox_node}/qemu/${vm.vmid}/snapshot/${params.name}/rollback`);
  await audit(req, "vm.snapshot.revert", slug, `vmid=${vm.vmid} name=${params.name}`);
  json(res, 202, { upid, vmid: vm.vmid, name: params.name });
}

async function deleteSnapshot(req, res, { slug, params }) {
  const vm = await vmBySlug(slug);
  if (!vm) return bad(res, 404, "vm not found", "not_found");
  if (!snapNameOk(params.name)) return bad(res, 400, "invalid snapshot name", "invalid_name");
  const upid = await pveApi("DELETE", `/nodes/${vm.proxmox_node}/qemu/${vm.vmid}/snapshot/${params.name}`);
  await db.exec(`DELETE FROM snapshots WHERE vmid = $1 AND proxmox_name = $2`, [vm.vmid, params.name]);
  await audit(req, "vm.snapshot.delete", slug, `vmid=${vm.vmid} name=${params.name}`);
  json(res, 202, { upid, vmid: vm.vmid, name: params.name });
}


// ── Backup policy (T2 #8) ─────────────────────────────────────────────
async function getBackupPolicy(req, res, { slug }) {
  const vm = await vmBySlug(slug);
  if (!vm) return bad(res, 404, "vm not found", "not_found");
  let row = await db.oneJson(
    `SELECT row_to_json(t) FROM (
       SELECT customer_slug, frequency, retention_days, time_utc::text AS time_utc,
              enabled, last_run_at FROM backup_policies WHERE customer_slug = $1
     ) t`,
    [slug],
  );
  if (!row) {
    // synthesise a default for the UI to render
    row = {
      customer_slug: slug,
      frequency: "daily",
      retention_days: 14,
      time_utc: "03:00:00",
      enabled: false,
      last_run_at: null,
    };
  }
  json(res, 200, row);
}

async function putBackupPolicy(req, res, { slug, body }) {
  const vm = await vmBySlug(slug);
  if (!vm) return bad(res, 404, "vm not found", "not_found");

  const frequency = body.frequency || "daily";
  if (!["hourly","daily","weekly","disabled"].includes(frequency)) {
    return bad(res, 400, "frequency must be hourly|daily|weekly|disabled", "invalid_frequency");
  }
  const retention = parseInt(body.retention_days || 14, 10);
  if (!Number.isInteger(retention) || retention < 1 || retention > 365) {
    return bad(res, 400, "retention_days must be 1–365", "invalid_retention");
  }
  const time = body.time_utc || "03:00:00";
  if (!/^([0-1]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(time)) {
    return bad(res, 400, "time_utc must be HH:MM[:SS] 24h UTC", "invalid_time");
  }
  const enabled = body.enabled !== false;

  const row = await db.oneJson(
    `WITH upserted AS (
       INSERT INTO backup_policies (customer_slug, frequency, retention_days, time_utc, enabled, updated_at)
       VALUES ($1, $2, $3, $4::time, $5, now())
       ON CONFLICT (customer_slug) DO UPDATE
         SET frequency = EXCLUDED.frequency,
             retention_days = EXCLUDED.retention_days,
             time_utc = EXCLUDED.time_utc,
             enabled = EXCLUDED.enabled,
             updated_at = now()
       RETURNING customer_slug, frequency, retention_days, time_utc::text AS time_utc,
                 enabled, last_run_at
     )
     SELECT row_to_json(t) FROM upserted t`,
    [slug, frequency, retention, time, enabled],
  );
  await audit(req, "vm.backup.policy", slug, `frequency=${frequency} retention=${retention} time=${time} enabled=${enabled}`);
  json(res, 200, row);
}

// ── Restore (T2 #9) ───────────────────────────────────────────────────
async function restoreBackup(req, res, { slug, params, jobs, randomUUID }) {
  const vm = await vmBySlug(slug);
  if (!vm) return bad(res, 404, "vm not found", "not_found");

  const backupId = parseInt(params.id, 10);
  if (!Number.isInteger(backupId) || backupId < 1) return bad(res, 400, "invalid backup id", "invalid_id");

  const backup = await db.oneJson(
    `SELECT row_to_json(t) FROM (
       SELECT id, started_at, status FROM backups WHERE id = $1 AND customer_slug = $2
     ) t`,
    [backupId, slug],
  );
  if (!backup) return bad(res, 404, "backup not found", "not_found");
  if (backup.status !== "succeeded") {
    return bad(res, 409, "can only restore from a succeeded backup", "invalid_status");
  }

  // Derive the timestamp from started_at: backup-supabase.sh names files
  // with %Y%m%dT%H%M%SZ derived from the script start time.
  const ts = new Date(backup.started_at).toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

  const jobId = randomUUID();
  const logPath = path.join(LOG_DIR, `${jobId}.log`);
  const job = {
    jobId, kind: "restore", slug, args: [],
    status: "queued", exitCode: null,
    startedAt: new Date().toISOString(), finishedAt: null,
    logPath, proc: null,
  };
  jobs.set(jobId, job);
  await audit(req, "vm.backup.restore", slug, `backup_id=${backupId} ts=${ts} job=${jobId}`);

  const scriptPath = path.join(SCRIPTS_DIR, "restore-customer.sh");
  if (!fs.existsSync(scriptPath)) {
    job.status = "failed"; job.exitCode = 127;
    return bad(res, 500, "restore script missing", "missing_script");
  }

  const stream = fs.createWriteStream(logPath, { flags: "a" });
  stream.write(`── ${job.startedAt} — restore ${slug} backup_id=${backupId} ts=${ts} — job ${jobId}\n\n`);
  job.status = "running";

  const { spawn: cpSpawn } = require("child_process");
  const proc = cpSpawn(scriptPath, ["--slug", slug, "--backup", ts, "--force"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  job.proc = proc;
  proc.stdout.on("data", (c) => stream.write(c));
  proc.stderr.on("data", (c) => stream.write(c));
  proc.on("close", (code) => {
    job.status = code === 0 ? "succeeded" : "failed";
    job.exitCode = code;
    job.finishedAt = new Date().toISOString();
    stream.end(`\n── exit ${code} at ${job.finishedAt}\n`);
    job.proc = null;
  });

  json(res, 202, { job_uuid: jobId, status: job.status, backup_id: backupId, ts });
}

// ── Encrypted download (T2 #10) ───────────────────────────────────────
async function downloadBackup(req, res, { slug, params, body }) {
  const vm = await vmBySlug(slug);
  if (!vm) return bad(res, 404, "vm not found", "not_found");

  const backupId = parseInt(params.id, 10);
  const passphrase = body && body.passphrase;
  if (!passphrase || typeof passphrase !== "string" || passphrase.length < 8) {
    return bad(res, 400, "passphrase (min 8 chars) required", "invalid_passphrase");
  }

  const backup = await db.oneJson(
    `SELECT row_to_json(t) FROM (
       SELECT id, started_at, status, b2_key FROM backups WHERE id = $1 AND customer_slug = $2
     ) t`,
    [backupId, slug],
  );
  if (!backup) return bad(res, 404, "backup not found", "not_found");
  if (backup.status !== "succeeded") return bad(res, 409, "backup not succeeded", "invalid_status");

  // Derive b2 key if not stored
  const ts = new Date(backup.started_at).toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const b2Key = backup.b2_key || `${slug}/postgres/customer-${slug}-${ts}.sql.gz`;

  await audit(req, "vm.backup.download", slug, `backup_id=${backupId} b2=${b2Key}`);

  res.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-disposition": `attachment; filename=\"backup-${slug}-${ts}.sql.gz.gpg\"`,
    "cache-control": "no-store",
  });

  // rclone cat | gpg --symmetric --passphrase-fd 0 → res
  const { spawn: cpSpawn } = require("child_process");
  const rc = cpSpawn("rclone", ["cat", `b2:wcn-cloud-backups/${b2Key}`], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  const gpg = cpSpawn("gpg", [
    "--batch", "--yes",
    "--passphrase-fd", "0",
    "--symmetric", "--cipher-algo", "AES256",
    "--no-tty",
  ], {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
  gpg.stdin.write(passphrase + "\n");
  rc.stdout.pipe(gpg.stdin);
  gpg.stdout.pipe(res);

  const errBufs = [];
  rc.stderr.on("data", (c) => errBufs.push(c));
  gpg.stderr.on("data", (c) => errBufs.push(c));

  let closed = false;
  req.on("close", () => {
    closed = true;
    try { rc.kill("SIGTERM"); } catch {}
    try { gpg.kill("SIGTERM"); } catch {}
  });

  gpg.on("close", (code) => {
    if (closed) return;
    if (code !== 0) {
      console.error("[backup.download] gpg exit", code, Buffer.concat(errBufs).toString());
    }
    res.end();
  });
}

module.exports = {
  power,
  restart,
  stop,
  start,
  resize,
  listSnapshots,
  createSnapshot,
  revertSnapshot,
  deleteSnapshot,
  listBackups,
  createBackup,
  getBackupPolicy,
  putBackupPolicy,
  restoreBackup,
  downloadBackup,
};
