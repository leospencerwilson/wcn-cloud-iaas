#!/usr/bin/env node
// WCN Cloud provisioner — HTTP trigger for provision-customer.sh.
// Runs on the Proxmox host (or wherever the orchestrator lives).
// No npm deps; Node 18+ stdlib only.
//
// Endpoints (all require Authorization: Bearer ${PROVISIONER_TOKEN}):
//   POST /provision         { slug }           → 202 { jobId }
//   POST /deprovision       { slug, force? }   → 202 { jobId }
//   GET  /jobs/:id                              → { status, exitCode, startedAt, finishedAt }
//   GET  /jobs/:id/stream                       → SSE; tails the log; emits event:done {exit}
//   GET  /healthz                               → "ok"
//
// Jobs are serial — a queue holds requests while one is running.
// Logs persist to LOG_DIR/<jobId>.log so an SSE client can reconnect.

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { randomUUID } = require("crypto");
const apps = require("./apps");
const vms = require("./vms");
const audit = require("./audit");
const redirects = require("./redirects");
const secrets = require("./secrets");
const metrics = require("./metrics");
const status = require("./status");
const alerts = require("./alerts");
const admin = require("./admin");
const certs = require("./certs");
const capacity = require("./capacity");
const teams = require("./teams");
const tokens = require("./tokens");
const migrate = require("./migrate");
const dns = require("./dns");
const bulk = require("./bulk");
const webhooks = require("./webhooks");
const dbquery = require("./dbquery");
const supabaseAdmin = require("./supabase-admin");
const tabviews = require("./tabviews");
const db = require("./db");
const limits = require("./limits");
process.on("unhandledRejection", (err) => {
  console.error("[unhandledRejection]", err && err.stack ? err.stack : err);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err && err.stack ? err.stack : err);
});


const PORT = parseInt(process.env.PORT || "9000", 10);
const TOKEN = process.env.PROVISIONER_TOKEN;
const SCRIPTS_DIR = process.env.SCRIPTS_DIR || "/opt/wcn-cloud/scripts";
const LOG_DIR = process.env.LOG_DIR || "/var/log/wcn-cloud/jobs";
// Watchdog ceiling for a single job (in-script step timeouts are the first line
// of defence; this is the backstop against a wholly-hung job).
const JOB_TIMEOUT_MS = parseInt(process.env.JOB_TIMEOUT_MS || "2700000", 10); // 45 min

if (!TOKEN) {
  console.error("PROVISIONER_TOKEN is not set — refusing to start.");
  process.exit(1);
}
fs.mkdirSync(LOG_DIR, { recursive: true });

// jobId → { status, exitCode, startedAt, finishedAt, kind, slug, logPath, proc }
const jobs = new Map();
const queue = [];
let current = null;

function authed(req) {
  const h = req.headers["authorization"] || "";
  return h === `Bearer ${TOKEN}`;
}

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      try {
        resolve(buf ? JSON.parse(buf) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

function enqueue(kind, slug, extraArgs = [], mode = null) {
  const jobId = randomUUID();
  const logPath = path.join(LOG_DIR, `${jobId}.log`);
  const job = {
    jobId,
    kind,
    slug,
    args: extraArgs,
    mode:
      mode ||
      (extraArgs.includes("--reset")
        ? "fresh"
        : extraArgs.includes("--resume")
          ? "resume"
          : "new"),
    status: "queued",
    exitCode: null,
    startedAt: null,
    finishedAt: null,
    logPath,
    proc: null,
    steps: [],
    cancelled: false,
    timedOut: false,
    watchdog: null,
  };
  jobs.set(jobId, job);
  persistJob(job).catch((e) => console.error("[db] persistJob:", e.message));
  queue.push(job);
  drain();
  return job;
}

// ── durable job/step state (mirror of the in-memory model into ops_db) ──
async function persistJob(job) {
  await db.exec(
    `INSERT INTO provision_jobs (id, kind, slug, mode, status, args)
       VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status`,
    [job.jobId, job.kind, job.slug, job.mode, job.status, JSON.stringify(job.args || [])],
  );
}

async function updateJobStatus(job) {
  await db.exec(
    `UPDATE provision_jobs
        SET status = $2, exit_code = $3, started_at = $4, finished_at = $5
      WHERE id = $1`,
    [job.jobId, job.status, job.exitCode, job.startedAt, job.finishedAt],
  );
}

function recordStep(job, key, state) {
  const nowIso = new Date().toISOString();
  let s = job.steps.find((x) => x.key === key);
  if (!s) {
    s = { key, state, startedAt: nowIso, finishedAt: null };
    job.steps.push(s);
  }
  s.state = state;
  if (state === "done" || state === "failed") s.finishedAt = nowIso;
  db.exec(
    `INSERT INTO provision_steps (job_id, key, state, started_at, finished_at)
       VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (job_id, key) DO UPDATE SET state = EXCLUDED.state, finished_at = EXCLUDED.finished_at`,
    [job.jobId, key, state, s.startedAt, s.finishedAt],
  ).catch(() => {});
}

// On boot, any DB job still 'queued'/'running' was orphaned by a crash/restart
// (the in-memory job + process are gone). Mark it failed and unstick the
// customer so it never sits at 'provisioning' forever (the VM 206 class).
async function reconcileOrphanedJobs() {
  try {
    const rows = await db.rows(
      "SELECT id, slug, kind FROM provision_jobs WHERE status IN ('queued','running')",
    );
    for (const [id, slug, kind] of rows) {
      await db.exec(
        "UPDATE provision_jobs SET status='failed', finished_at=now(), error='orphaned by provisioner restart' WHERE id=$1",
        [id],
      );
      if (kind === "provision") {
        await db.exec(
          "UPDATE customers SET status='failed' WHERE slug=$1 AND status='provisioning'",
          [slug],
        );
      }
      console.log(`[reconcile] orphaned job ${id} (${slug}) → failed`);
    }
    if (rows.length) console.log(`[reconcile] cleaned ${rows.length} orphaned job(s)`);
  } catch (e) {
    console.error("[reconcile] error:", e.message);
  }
}

function drain() {
  if (current) return;
  const job = queue.shift();
  if (!job) return;
  current = job;

  const scriptName =
    job.kind === "provision" ? "provision-customer.sh" : "deprovision-customer.sh";
  const scriptPath = path.join(SCRIPTS_DIR, scriptName);

  const logStream = fs.createWriteStream(job.logPath, { flags: "a" });
  const header =
    `── ${new Date().toISOString()} — ${job.kind} ${job.slug} — job ${job.jobId}\n` +
    `── ${scriptPath} --slug ${job.slug} ${job.args.join(" ")}\n\n`;
  logStream.write(header);

  job.status = "running";
  job.startedAt = new Date().toISOString();
  updateJobStatus(job).catch(() => {});

  const args = ["--slug", job.slug, ...job.args];
  const proc = spawn(scriptPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  job.proc = proc;

  // Tee stdout to the log AND parse WCN_STEP markers into the structured step
  // model (line-buffered — markers can span chunk boundaries).
  let stdoutBuf = "";
  proc.stdout.on("data", (c) => {
    logStream.write(c);
    stdoutBuf += c.toString("utf8");
    let nl;
    while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      const mm = /^WCN_STEP (\S+) (running|done|failed)\b/.exec(line);
      if (mm) recordStep(job, mm[1], mm[2]);
    }
  });
  proc.stderr.on("data", (c) => logStream.write(c));

  // Backstop watchdog for a wholly-hung job.
  job.watchdog = setTimeout(() => {
    job.timedOut = true;
    logStream.write(`\n[watchdog] job exceeded ${Math.round(JOB_TIMEOUT_MS / 1000)}s — sending SIGTERM\n`);
    try { proc.kill("SIGTERM"); } catch {}
    setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 10000);
  }, JOB_TIMEOUT_MS);

  proc.on("error", (err) => {
    logStream.write(`\n[receiver] spawn error: ${err.message}\n`);
  });

  proc.on("close", (code) => {
    if (job.watchdog) { clearTimeout(job.watchdog); job.watchdog = null; }
    job.status = job.cancelled
      ? "cancelled"
      : job.timedOut
        ? "failed"
        : code === 0
          ? "succeeded"
          : "failed";
    job.exitCode = code;
    job.finishedAt = new Date().toISOString();
    job.proc = null;
    logStream.end(`\n── exit ${code} (${job.status}) at ${job.finishedAt}\n`);
    updateJobStatus(job).catch(() => {});
    current = null;
    setImmediate(drain);
  });
}

// SSE: stream the log file as it grows; close when job finishes.
function streamLog(req, res, job) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(`event: meta\ndata: ${JSON.stringify({ status: job.status, kind: job.kind, slug: job.slug })}\n\n`);

  let offset = 0;
  let closed = false;
  req.on("close", () => {
    closed = true;
  });

  function send(chunk) {
    // SSE: prefix every line with "data: "
    const lines = chunk.split(/\r?\n/);
    const payload = lines.map((l) => `data: ${l}`).join("\n");
    res.write(payload + "\n\n");
  }

  function tick() {
    if (closed) return;
    fs.stat(job.logPath, (err, st) => {
      if (err) {
        if (job.status === "queued") {
          setTimeout(tick, 250);
          return;
        }
        finish();
        return;
      }
      if (st.size > offset) {
        const stream = fs.createReadStream(job.logPath, { start: offset, end: st.size - 1 });
        let buf = "";
        stream.on("data", (c) => (buf += c.toString("utf8")));
        stream.on("end", () => {
          offset = st.size;
          if (buf) send(buf);
          schedule();
        });
        stream.on("error", schedule);
      } else {
        schedule();
      }
    });
  }

  function schedule() {
    if (closed) return;
    if (job.status === "running" || job.status === "queued") {
      setTimeout(tick, 400);
    } else {
      // Job is finished. Make sure any tail is flushed, then close.
      fs.stat(job.logPath, (err, st) => {
        if (!err && st.size > offset) {
          const stream = fs.createReadStream(job.logPath, { start: offset, end: st.size - 1 });
          let buf = "";
          stream.on("data", (c) => (buf += c.toString("utf8")));
          stream.on("end", () => {
            if (buf) send(buf);
            offset = st.size;
            finish();
          });
        } else {
          finish();
        }
      });
    }
  }

  function finish() {
    if (closed) return;
    closed = true;
    res.write(
      `event: done\ndata: ${JSON.stringify({
        status: job.status,
        exitCode: job.exitCode,
        finishedAt: job.finishedAt,
      })}\n\n`,
    );
    res.end();
  }

  tick();

  // Heartbeat so proxies don't time the connection out mid-job.
  const hb = setInterval(() => {
    if (closed) {
      clearInterval(hb);
      return;
    }
    res.write(": ping\n\n");
  }, 15000);
  req.on("close", () => clearInterval(hb));
}


// Per-component tri-state health for a customer (DNS, tunnel, VM networking,
// docker, coolify, caddy, cloudflared, supabase, metrics). Reuses the same
// check logic as the provision gate via `customer-health-check.sh --json`,
// which runs every check independently and prints a JSON array on stdout.
function customerHealth(req, res, { slug }) {
  const sh = path.join(SCRIPTS_DIR, "customer-health-check.sh");
  const child = spawn(sh, [slug, "--json", "--with-metrics"], { env: process.env });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.on("close", () => {
    let components = null;
    const lastLine = out.trim().split("\n").filter(Boolean).pop() || "";
    try { components = JSON.parse(lastLine); } catch {}
    if (!Array.isArray(components)) {
      return json(res, 200, { components: [], error: "no health json" });
    }
    json(res, 200, { components, checked_at: new Date().toISOString() });
  });
  child.on("error", (e) => json(res, 502, { error: e.message }));
}

function slugFromReq(req, parsedUrl) {
  const fromQuery = parsedUrl.searchParams.get("slug");
  const fromHdr   = req.headers["x-wcn-customer-slug"];
  const slug = fromQuery || fromHdr || "";
  return SLUG_RE.test(slug) ? slug : null;
}

function readBodyOr(req) {
  return readBody(req).catch(() => ({}));
}

const server = http.createServer(async (req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }

  // — Public status (no auth) —
  const stM = /^\/public\/status\/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])\/?$/.exec(req.url || "");
  if (stM && req.method === "GET") {
    try {
      return await status.publicStatus(req, res, { slug: stM[1] });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  if (!authed(req)) {
    json(res, 401, { error: "unauthorized" });
    return;
  }

  // POST /provision
  if (req.method === "POST" && req.url === "/provision") {
    try {
      const body = await readBody(req);
      if (!body.slug || typeof body.slug !== "string" || !SLUG_RE.test(body.slug)) {
        return json(res, 400, { error: "invalid slug" });
      }
      const extra = [];
      const str = (v) => (typeof v === "string" ? v : "");
      // Whitelist of forwarded flags. All values are passed as separate argv
      // items, so shell interpolation is not a concern.
      if (str(body.tier)) extra.push("--tier", str(body.tier));
      if (str(body.name)) extra.push("--name", str(body.name));
      if (str(body.email)) extra.push("--email", str(body.email));
      if (str(body.domain)) extra.push("--domain", str(body.domain));
      if (str(body.brandColour)) extra.push("--brand-colour", str(body.brandColour));
      // Optional VM resources (ask 1). Validate as ints against shared bounds
      // before they reach the shell; the script re-validates + tier-defaults.
      try {
        if (body.cores != null && body.cores !== "")
          extra.push("--cores", String(limits.validateInt("cores", body.cores)));
        if (body.memoryMb != null && body.memoryMb !== "")
          extra.push("--memory-mb", String(limits.validateInt("memory_mb", body.memoryMb)));
        if (body.diskGb != null && body.diskGb !== "")
          extra.push("--disk-gb", String(limits.validateInt("disk_gb", body.diskGb)));
      } catch (e) {
        return json(res, e.status || 400, { error: e.message, code: e.code });
      }
      if (body.resume) extra.push("--resume");
      const job = enqueue("provision", body.slug, extra);
      return json(res, 202, { jobId: job.jobId, status: job.status });
    } catch (e) {
      return json(res, 400, { error: "bad json" });
    }
  }

  // POST /deprovision
  if (req.method === "POST" && req.url === "/deprovision") {
    try {
      const body = await readBody(req);
      if (!body.slug || typeof body.slug !== "string" || !SLUG_RE.test(body.slug)) {
        return json(res, 400, { error: "invalid slug" });
      }
      const extra = body.force ? ["--force"] : [];
      const job = enqueue("deprovision", body.slug, extra);
      return json(res, 202, { jobId: job.jobId, status: job.status });
    } catch (e) {
      return json(res, 400, { error: "bad json" });
    }
  }

  // GET /jobs/:id[/stream|/log]  ·  POST /jobs/:id/(cancel|retry)
  const m = /^\/jobs\/([0-9a-f-]{36})(?:\/(stream|log|cancel|retry))?$/.exec(
    req.url ? req.url.split("?")[0] : "",
  );
  if (m) {
    const jobId = m[1];
    const action = m[2] || "";

    // /log reads the persisted file, so it works even for jobs lost from
    // memory after a restart (UUID-validated path → no traversal).
    if (action === "log" && req.method === "GET") {
      try {
        const txt = fs.readFileSync(path.join(LOG_DIR, `${jobId}.log`), "utf8");
        res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
        return res.end(txt);
      } catch {
        return json(res, 404, { error: "no log" });
      }
    }

    const job = jobs.get(jobId);
    if (!job) return json(res, 404, { error: "not found" });

    if (action === "stream" && req.method === "GET") return streamLog(req, res, job);

    if (action === "cancel" && req.method === "POST") {
      if (job.status === "running" || job.status === "queued") {
        job.cancelled = true;
        if (job.proc) {
          try { job.proc.kill("SIGTERM"); } catch {}
        } else {
          // Queued but not yet started: drop it from the queue.
          const i = queue.indexOf(job);
          if (i >= 0) queue.splice(i, 1);
          job.status = "cancelled";
          job.finishedAt = new Date().toISOString();
          updateJobStatus(job).catch(() => {});
        }
        return json(res, 202, { jobId, status: "cancelling" });
      }
      return json(res, 409, { error: `job is ${job.status}` });
    }

    if (action === "retry" && req.method === "POST") {
      if (job.kind !== "provision") return json(res, 400, { error: "only provision jobs can be retried" });
      const mode =
        new URL(req.url || "/", "http://localhost").searchParams.get("mode") === "fresh"
          ? "fresh"
          : "resume";
      const base = (job.args || []).filter((a) => a !== "--resume" && a !== "--reset");
      const newArgs = mode === "fresh" ? [...base, "--reset"] : [...base, "--resume"];
      const nj = enqueue("provision", job.slug, newArgs, mode);
      return json(res, 202, { jobId: nj.jobId, status: nj.status, mode });
    }

    if (action === "" && req.method === "GET") {
      return json(res, 200, {
        jobId: job.jobId,
        kind: job.kind,
        slug: job.slug,
        mode: job.mode,
        status: job.status,
        exitCode: job.exitCode,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        steps: job.steps,
      });
    }
  }


  // — /apps/* —
  const u = new URL(req.url || "/", "http://localhost");
  const m1 = /^\/apps\/?$/.exec(u.pathname);
  const m2 = /^\/apps\/([0-9a-f-]{36})$/.exec(u.pathname);
  const m3 = /^\/apps\/([0-9a-f-]{36})\/(deploy|deployments|logs|env|restart|stop|start|rollback|cron|exec|metrics)$/.exec(u.pathname);
  const m4 = /^\/apps\/([0-9a-f-]{36})\/domains\/?$/.exec(u.pathname);
  const m5 = /^\/apps\/([0-9a-f-]{36})\/domains\/([^\/]+)$/.exec(u.pathname);

  const slug = slugFromReq(req, u);
  const query = Object.fromEntries(u.searchParams);

  try {
    if (m1 && req.method === "GET")  return await apps.list(req, res, { slug, query });
    if (m1 && req.method === "POST") {
      const body = await readBodyOr(req);
      return await apps.create(req, res, { slug, body });
    }
    if (m2) {
      const params = { id: m2[1] };
      if (!slug) return json(res, 400, { error: "missing slug", code: "missing_slug" });
      if (req.method === "GET")    return await apps.get(req, res,    { slug, params });
      if (req.method === "PATCH")  return await apps.patch(req, res,  { slug, params, body: await readBodyOr(req) });
      if (req.method === "DELETE") return await apps.delete(req, res, { slug, params });
    }
    if (m3) {
      const params = { id: m3[1] }, action = m3[2];
      if (!slug) return json(res, 400, { error: "missing slug", code: "missing_slug" });
      if (action === "deploy"      && req.method === "POST") return await apps.deploy(req, res,      { slug, params, body: await readBodyOr(req) });
      if (action === "restart"     && req.method === "POST") return await apps.restart(req, res,     { slug, params });
      if (action === "stop"        && req.method === "POST") return await apps.stop(req, res,        { slug, params });
      if (action === "start"       && req.method === "POST") return await apps.start(req, res,       { slug, params });
      if (action === "rollback"    && req.method === "POST") return await apps.rollback(req, res,    { slug, params, body: await readBodyOr(req) });
      if (action === "cron"        && req.method === "GET")  return await apps.cronList(req, res,    { slug, params });
      if (action === "cron"        && req.method === "POST") return await apps.cronCreate(req, res,  { slug, params, body: await readBodyOr(req) });
      if (action === "exec"        && req.method === "POST") return await apps.execCommand(req, res, { slug, params, body: await readBodyOr(req) });
      if (action === "metrics"     && req.method === "GET")  return await metrics.appMetrics(req, res, { slug, params, query });
      if (action === "deployments" && req.method === "GET")  return await apps.deployments(req, res, { slug, params });
      if (action === "logs"        && req.method === "GET")  {
        if ((query.follow === "true" || query.follow === "1")) return await apps.streamRuntimeLogs(req, res, { slug, params, query });
        return await apps.logs(req, res, { slug, params, query });
      }
      if (action === "env"         && req.method === "GET")  return await apps.envGet(req, res,      { slug, params });
      if (action === "env"         && req.method === "PUT")  return await apps.envPut(req, res,      { slug, params, body: await readBodyOr(req) });
    }
    if (m4) {
      const params = { id: m4[1] };
      if (!slug) return json(res, 400, { error: "missing slug", code: "missing_slug" });
      if (req.method === "GET")  return await apps.domainsList(req, res, { slug, params });
      if (req.method === "POST") return await apps.domainAdd(req, res,   { slug, params, body: await readBodyOr(req) });
    }
    if (m5) {
      const params = { id: m5[1], hostname: decodeURIComponent(m5[2]) };
      if (!slug) return json(res, 400, { error: "missing slug", code: "missing_slug" });
      if (req.method === "GET")    return await apps.domainStatus(req, res, { slug, params });
      if (req.method === "DELETE") return await apps.domainDelete(req, res, { slug, params });
    }
  } catch (e) {
    return json(res, e.status || 500, { error: e.message, code: e.code || "internal_error" });
  }


  // — /voip/summary —
  if (u.pathname === "/voip/summary" && req.method === "GET") {
    return await metrics.voipSummary(req, res);
  }

  // — /vms/{slug}/* —
  const vmm1 = /^\/vms\/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])\/(power|restart|stop|start|backups|resize|snapshots|metrics|backup-policy|health)\/?$/.exec(u.pathname);
  if (vmm1) {
    const vSlug = vmm1[1];
    const action = vmm1[2];
    try {
      if (action === "health"  && req.method === "GET")  return customerHealth(req, res,    { slug: vSlug });
      if (action === "power"   && req.method === "GET")  return await vms.power(req, res,   { slug: vSlug });
      if (action === "restart" && req.method === "POST") return await vms.restart(req, res, { slug: vSlug });
      if (action === "stop"    && req.method === "POST") return await vms.stop(req, res,    { slug: vSlug });
      if (action === "start"   && req.method === "POST") return await vms.start(req, res,   { slug: vSlug });
      if (action === "backups" && req.method === "GET")  return await vms.listBackups(req, res,  { slug: vSlug });
      if (action === "backups" && req.method === "POST") return await vms.createBackup(req, res, { slug: vSlug, jobs, randomUUID });
      if (action === "resize"    && req.method === "POST") return await vms.resize(req, res,         { slug: vSlug, body: await readBodyOr(req) });
      if (action === "snapshots" && req.method === "GET")  return await vms.listSnapshots(req, res,  { slug: vSlug });
      if (action === "snapshots" && req.method === "POST") return await vms.createSnapshot(req, res, { slug: vSlug, body: await readBodyOr(req) });
      if (action === "metrics"   && req.method === "GET")  return await metrics.vmMetrics(req, res,    { slug: vSlug, query });
      if (action === "backup-policy" && req.method === "GET")  return await vms.getBackupPolicy(req, res, { slug: vSlug });
      if (action === "backup-policy" && req.method === "PUT")  return await vms.putBackupPolicy(req, res, { slug: vSlug, body: await readBodyOr(req) });
    } catch (e) {
      return json(res, e.status || 500, { error: e.message, code: e.code || "internal_error" });
    }
  }


  // — /apps/{id}/deployments/{deploy_id}/logs — SSE stream
  const m6 = /^\/apps\/([0-9a-f-]{36})\/deployments\/([0-9a-zA-Z-]{20,40})\/logs$/.exec(u.pathname);
  if (m6 && req.method === "GET") {
    if (!slug) return json(res, 400, { error: "missing slug", code: "missing_slug" });
    const params = { id: m6[1], deployment_id: m6[2] };
    try {
      return await apps.streamDeployLog(req, res, { slug, params });
    } catch (e) {
      return json(res, e.status || 500, { error: e.message, code: e.code || "internal_error" });
    }
  }


  // — /apps/{id}/cron/{task_uuid} —
  const m7 = /^\/apps\/([0-9a-f-]{36})\/cron\/([0-9a-zA-Z-]{20,40})$/.exec(u.pathname);
  if (m7 && req.method === "DELETE") {
    if (!slug) return json(res, 400, { error: "missing slug", code: "missing_slug" });
    const params = { id: m7[1], task_uuid: m7[2] };
    try {
      return await apps.cronDelete(req, res, { slug, params });
    } catch (e) {
      return json(res, e.status || 500, { error: e.message, code: e.code || "internal_error" });
    }
  }


  // — /vms/{slug}/snapshots/{name}[/revert] —
  const vsM = /^\/vms\/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])\/snapshots\/([a-zA-Z][a-zA-Z0-9_-]{0,39})(\/revert)?$/.exec(u.pathname);
  if (vsM) {
    const vSlug = vsM[1];
    const snapName = vsM[2];
    const isRevert = !!vsM[3];
    try {
      if (isRevert && req.method === "POST") return await vms.revertSnapshot(req, res, { slug: vSlug, params: { name: snapName } });
      if (!isRevert && req.method === "DELETE") return await vms.deleteSnapshot(req, res, { slug: vSlug, params: { name: snapName } });
    } catch (e) {
      return json(res, e.status || 500, { error: e.message, code: e.code || "internal_error" });
    }
  }


  // — /customers/{slug}/audit —
  const auM = /^\/customers\/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])\/audit\/?$/.exec(u.pathname);
  if (auM && req.method === "GET") {
    try {
      return await audit.list(req, res, { slug: auM[1], query });
    } catch (e) {
      return json(res, e.status || 500, { error: e.message, code: e.code || "internal_error" });
    }
  }


  // — /apps/{id}/redirects + /apps/{id}/redirects/{rid} —
  const rdM1 = /^\/apps\/([0-9a-f-]{36})\/redirects\/?$/.exec(u.pathname);
  const rdM2 = /^\/apps\/([0-9a-f-]{36})\/redirects\/(\d+)$/.exec(u.pathname);
  if (rdM1 || rdM2) {
    if (!slug) return json(res, 400, { error: "missing slug", code: "missing_slug" });
    try {
      if (rdM1 && req.method === "GET")  return await redirects.list(req, res, { slug, params: { id: rdM1[1] } });
      if (rdM1 && req.method === "POST") return await redirects.add(req, res,  { slug, params: { id: rdM1[1] }, body: await readBodyOr(req) });
      if (rdM2 && req.method === "DELETE") return await redirects.delete(req, res, { slug, params: { id: rdM2[1], rid: rdM2[2] } });
    } catch (e) {
      return json(res, e.status || 500, { error: e.message, code: e.code || "internal_error" });
    }
  }


  // — /apps/{id}/secrets + /apps/{id}/secrets/reveal + /apps/{id}/secrets/{KEY} —
  const seM1 = /^\/apps\/([0-9a-f-]{36})\/secrets\/?$/.exec(u.pathname);
  const seMR = /^\/apps\/([0-9a-f-]{36})\/secrets\/reveal$/.exec(u.pathname);
  const seM2 = /^\/apps\/([0-9a-f-]{36})\/secrets\/([A-Z][A-Z0-9_]{0,63})$/.exec(u.pathname);
  if (seM1 || seMR || seM2) {
    if (!slug) return json(res, 400, { error: "missing slug", code: "missing_slug" });
    try {
      if (seM1 && req.method === "GET") return await secrets.list(req, res, { slug, params: { id: seM1[1] } });
      if (seM1 && req.method === "PUT") return await secrets.put(req, res,  { slug, params: { id: seM1[1] }, body: await readBodyOr(req) });
      if (seMR && req.method === "POST") return await secrets.reveal(req, res, { slug, params: { id: seMR[1] }, body: await readBodyOr(req) });
      if (seM2 && req.method === "DELETE") return await secrets.delete(req, res, { slug, params: { id: seM2[1], key: seM2[2] } });
    } catch (e) {
      return json(res, e.status || 500, { error: e.message, code: e.code || "internal_error" });
    }
  }


  // — /alerts/* —
  const alM1 = /^\/alerts\/(webhook|firings|rules)\/?$/.exec(req.url ? req.url.split("?")[0] : "");
  if (alM1) {
    const action = alM1[1];
    try {
      if (action === "webhook" && req.method === "POST") {
        const body = await readBodyOr(req);
        return await alerts.webhook(req, res, { body });
      }
      if (action === "firings" && req.method === "GET") {
        const u2 = new URL(req.url || "/", "http://localhost");
        return await alerts.listFirings(req, res, { query: Object.fromEntries(u2.searchParams) });
      }
      if (action === "rules" && req.method === "GET") {
        return await alerts.listRules(req, res);
      }
    } catch (e) {
      return json(res, e.status || 500, { error: e.message, code: e.code || "internal_error" });
    }
  }


  // — POST /admin/impersonate —
  if (req.url === "/admin/impersonate" && req.method === "POST") {
    try {
      const body = await readBodyOr(req);
      return await admin.impersonate(req, res, { body });
    } catch (e) {
      return json(res, e.status || 500, { error: e.message, code: e.code || "internal_error" });
    }
  }


  // — /vms/{slug}/backups/{id}/(restore|download) —
  const bkAct = /^\/vms\/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])\/backups\/(\d+)\/(restore|download)$/.exec(u.pathname);
  if (bkAct && req.method === "POST") {
    const vSlug = bkAct[1];
    const params = { id: bkAct[2] };
    const which = bkAct[3];
    try {
      if (which === "restore")  return await vms.restoreBackup(req, res, { slug: vSlug, params, jobs, randomUUID });
      if (which === "download") return await vms.downloadBackup(req, res, { slug: vSlug, params, body: await readBodyOr(req) });
    } catch (e) {
      return json(res, e.status || 500, { error: e.message, code: e.code || "internal_error" });
    }
  }


  // — /apps/{id}/domains/{hostname}/cert —
  const crM = /^\/apps\/([0-9a-f-]{36})\/domains\/([^\/]+)\/cert$/.exec(u.pathname);
  if (crM) {
    if (!slug) return json(res, 400, { error: "missing slug", code: "missing_slug" });
    const params = { id: crM[1], hostname: decodeURIComponent(crM[2]) };
    try {
      if (req.method === "GET")    return await certs.get(req, res,    { slug, params });
      if (req.method === "POST")   return await certs.upload(req, res, { slug, params, body: await readBodyOr(req) });
      if (req.method === "DELETE") return await certs.delete(req, res, { slug, params });
    } catch (e) {
      return json(res, e.status || 500, { error: e.message, code: e.code || "internal_error" });
    }
  }


  // — T3 #29: capacity —
  if (req.url && req.url.split("?")[0] === "/admin/capacity" && req.method === "GET") {
    try { return await capacity.get(req, res); } catch (e) { return json(res, e.status || 500, { error: e.message }); }
  }

  // — T3 #25: teams —
  const teamListM = /^\/customers\/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])\/team\/?$/.exec(u.pathname);
  if (teamListM && req.method === "GET") {
    try { return await teams.list(req, res, { slug: teamListM[1] }); } catch (e) { return json(res, e.status || 500, { error: e.message }); }
  }
  const teamInviteM = /^\/customers\/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])\/team\/invites\/?$/.exec(u.pathname);
  if (teamInviteM && req.method === "POST") {
    try { return await teams.invite(req, res, { slug: teamInviteM[1], body: await readBodyOr(req) }); } catch (e) { return json(res, e.status || 500, { error: e.message }); }
  }
  const teamLookupM = /^\/customers\/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])\/team\/by-email\/?$/.exec(u.pathname);
  if (teamLookupM && req.method === "GET") {
    try { return await teams.lookup(req, res, { slug: teamLookupM[1], query }); } catch (e) { return json(res, e.status || 500, { error: e.message }); }
  }
  const teamMemM = /^\/customers\/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])\/team\/(\d+)$/.exec(u.pathname);
  if (teamMemM) {
    try {
      if (req.method === "PATCH")  return await teams.update(req, res, { slug: teamMemM[1], params: { id: teamMemM[2] }, body: await readBodyOr(req) });
      if (req.method === "DELETE") return await teams.revoke(req, res, { slug: teamMemM[1], params: { id: teamMemM[2] } });
    } catch (e) { return json(res, e.status || 500, { error: e.message }); }
  }
  if (u.pathname === "/team/invites/accept" && req.method === "POST") {
    try { return await teams.accept(req, res, { body: await readBodyOr(req) }); } catch (e) { return json(res, e.status || 500, { error: e.message }); }
  }

  // — T3 #26: api tokens —
  const tokListM = /^\/customers\/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])\/tokens\/?$/.exec(u.pathname);
  if (tokListM) {
    try {
      if (req.method === "GET")  return await tokens.list(req, res,  { slug: tokListM[1] });
      if (req.method === "POST") return await tokens.issue(req, res, { slug: tokListM[1], body: await readBodyOr(req) });
    } catch (e) { return json(res, e.status || 500, { error: e.message }); }
  }
  const tokOneM = /^\/customers\/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])\/tokens\/(\d+)$/.exec(u.pathname);
  if (tokOneM && req.method === "DELETE") {
    try { return await tokens.revoke(req, res, { slug: tokOneM[1], params: { id: tokOneM[2] } }); } catch (e) { return json(res, e.status || 500, { error: e.message }); }
  }
  if (u.pathname === "/tokens/validate" && req.method === "POST") {
    try { return await tokens.validate(req, res, { body: await readBodyOr(req) }); } catch (e) { return json(res, e.status || 500, { error: e.message }); }
  }


  // — DNS provider integrations (T8: Custom Domain Auto-DNS) —
  if (u.pathname === "/dns-providers" && req.method === "GET") {
    try { return await dns.providersMeta(req, res); } catch (e) { return json(res, e.status || 500, { error: e.message }); }
  }
  const dnsListM = /^\/customers\/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])\/dns-integrations\/?$/.exec(u.pathname);
  if (dnsListM) {
    try {
      if (req.method === "GET")  return await dns.list(req, res, { slug: dnsListM[1] });
      if (req.method === "POST") return await dns.create(req, res, { slug: dnsListM[1], body: await readBodyOr(req) });
    } catch (e) { return json(res, e.status || 500, { error: e.message }); }
  }
  const dnsOneM = /^\/customers\/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])\/dns-integrations\/([0-9a-f-]{36})$/.exec(u.pathname);
  if (dnsOneM) {
    try {
      if (req.method === "GET")    return await dns.get(req, res,    { slug: dnsOneM[1], id: dnsOneM[2] });
      if (req.method === "DELETE") return await dns.remove(req, res, { slug: dnsOneM[1], id: dnsOneM[2] });
    } catch (e) { return json(res, e.status || 500, { error: e.message }); }
  }
  const dnsTestM = /^\/customers\/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])\/dns-integrations\/([0-9a-f-]{36})\/test$/.exec(u.pathname);
  if (dnsTestM && req.method === "POST") {
    try { return await dns.test(req, res, { slug: dnsTestM[1], id: dnsTestM[2] }); } catch (e) { return json(res, e.status || 500, { error: e.message }); }
  }
  const dnsZonesM = /^\/customers\/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])\/dns-integrations\/([0-9a-f-]{36})\/zones$/.exec(u.pathname);
  if (dnsZonesM && req.method === "POST") {
    try { return await dns.refreshZones(req, res, { slug: dnsZonesM[1], id: dnsZonesM[2] }); } catch (e) { return json(res, e.status || 500, { error: e.message }); }
  }

  // — T3 #30: bulk ops —
  if (u.pathname === "/admin/bulk" && req.method === "GET") {
    try { return await bulk.list(req, res, { query }); } catch (e) { return json(res, e.status || 500, { error: e.message }); }
  }
  if (u.pathname === "/admin/bulk" && req.method === "POST") {
    try { return await bulk.create(req, res, { body: await readBodyOr(req) }); } catch (e) { return json(res, e.status || 500, { error: e.message }); }
  }
  const bulkOneM = /^\/admin\/bulk\/(\d+)$/.exec(u.pathname);
  if (bulkOneM && req.method === "GET") {
    try { return await bulk.get(req, res, { params: { id: bulkOneM[1] } }); } catch (e) { return json(res, e.status || 500, { error: e.message }); }
  }
  const bulkAbortM = /^\/admin\/bulk\/(\d+)\/abort$/.exec(u.pathname);
  if (bulkAbortM && req.method === "POST") {
    try { return await bulk.abort(req, res, { params: { id: bulkAbortM[1] } }); } catch (e) { return json(res, e.status || 500, { error: e.message }); }
  }


  // — #21: GitHub push-to-deploy webhook config —
  const whAppM = /^\/apps\/([0-9a-f-]{36})\/webhook$/.exec(u.pathname);
  if (whAppM) {
    if (!slug) return json(res, 400, { error: "missing slug", code: "missing_slug" });
    const params = { id: whAppM[1] };
    try {
      if (req.method === "POST")   return await webhooks.create(req, res, { slug, params, body: await readBodyOr(req) });
      if (req.method === "GET")    return await webhooks.get(req, res,    { slug, params });
      if (req.method === "PATCH")  return await webhooks.update(req, res, { slug, params, body: await readBodyOr(req) });
      if (req.method === "DELETE") return await webhooks.delete(req, res, { slug, params });
    } catch (e) { return json(res, e.status || 500, { error: e.message }); }
  }
  if (u.pathname === "/webhooks/github/lookup" && req.method === "POST") {
    try { return await webhooks.lookup(req, res, { body: await readBodyOr(req) }); }
    catch (e) { return json(res, e.status || 500, { error: e.message }); }
  }
  if (u.pathname === "/webhooks/github/delivered" && req.method === "POST") {
    try { return await webhooks.delivered(req, res, { body: await readBodyOr(req) }); }
    catch (e) { return json(res, e.status || 500, { error: e.message }); }
  }

  // — #17: Embedded DB GUI —
  const dbM = /^\/vms\/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])\/db\/(query|tables|columns|sizes|rows)$/.exec(u.pathname);
  if (dbM) {
    const vSlug = dbM[1];
    const action = dbM[2];
    try {
      if (action === "query"   && req.method === "POST") return await dbquery.query(req, res,   { slug: vSlug, body: await readBodyOr(req) });
      if (action === "tables"  && req.method === "GET")  return await dbquery.tables(req, res,  { slug: vSlug });
      if (action === "columns" && req.method === "GET")  return await dbquery.columns(req, res, { slug: vSlug, query });
      if (action === "sizes"   && req.method === "GET")  return await dbquery.sizes(req, res,   { slug: vSlug });
      if (action === "rows"    && req.method === "GET")  return await supabaseAdmin.rows(req, res, { slug: vSlug, query });
    } catch (e) { return json(res, e.status || 500, { error: e.message }); }
  }

  // — Supabase admin: lists (GET) and mutations on collection paths —
  const sbM = /^\/vms\/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])\/supabase\/(auth\/users|storage\/buckets|storage\/objects|policies|realtime|functions)$/.exec(u.pathname);
  if (sbM) {
    const vSlug = sbM[1];
    const path = sbM[2];
    try {
      if (req.method === "GET") {
        if (path === "auth/users")       return await supabaseAdmin.authUsers(req, res, { slug: vSlug, query });
        if (path === "storage/buckets")  return await supabaseAdmin.storageBuckets(req, res, { slug: vSlug });
        if (path === "storage/objects")  return await supabaseAdmin.storageObjects(req, res, { slug: vSlug, query });
        if (path === "policies")         return await supabaseAdmin.policies(req, res, { slug: vSlug });
        if (path === "realtime")         return await supabaseAdmin.realtime(req, res, { slug: vSlug });
        if (path === "functions")        return await supabaseAdmin.functions(req, res, { slug: vSlug });
      }
      if (req.method === "POST") {
        const body = await readBodyOr(req);
        if (path === "auth/users")      return await supabaseAdmin.authCreateUser(req, res, { slug: vSlug, body });
        if (path === "storage/buckets") return await supabaseAdmin.storageCreateBucket(req, res, { slug: vSlug, body });
        if (path === "policies")        return await supabaseAdmin.policyCreate(req, res, { slug: vSlug, body });
      }
      if (req.method === "DELETE") {
        if (path === "storage/objects") return await supabaseAdmin.storageDeleteObject(req, res, { slug: vSlug, query });
        if (path === "policies")        return await supabaseAdmin.policyDelete(req, res, { slug: vSlug, query });
      }
    } catch (e) { return json(res, e.status || 500, { error: e.message }); }
  }

  // — Supabase admin: per-resource paths (auth user id, bucket name) —
  const sbU = /^\/vms\/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])\/supabase\/auth\/users\/([0-9a-f-]{36})$/.exec(u.pathname);
  if (sbU) {
    const vSlug = sbU[1];
    const params = { id: sbU[2] };
    try {
      if (req.method === "PATCH" || req.method === "PUT") {
        const body = await readBodyOr(req);
        return await supabaseAdmin.authUpdateUser(req, res, { slug: vSlug, params, body });
      }
      if (req.method === "DELETE") {
        return await supabaseAdmin.authDeleteUser(req, res, { slug: vSlug, params });
      }
    } catch (e) { return json(res, e.status || 500, { error: e.message }); }
  }

  const sbB = /^\/vms\/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])\/supabase\/storage\/buckets\/([a-z0-9][a-z0-9._-]{0,62})$/.exec(u.pathname);
  if (sbB && req.method === "DELETE") {
    const vSlug = sbB[1];
    const params = { name: sbB[2] };
    try {
      return await supabaseAdmin.storageDeleteBucket(req, res, { slug: vSlug, params });
    } catch (e) { return json(res, e.status || 500, { error: e.message }); }
  }

  // — Storage object upload (streams raw body to Kong) —
  const sbUp = /^\/vms\/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])\/supabase\/storage\/objects\/upload$/.exec(u.pathname);
  if (sbUp && req.method === "POST") {
    try {
      return await supabaseAdmin.storageUploadObject(req, res, { slug: sbUp[1], query });
    } catch (e) { return json(res, e.status || 500, { error: e.message }); }
  }

  // — Edge function deploy + list + source + delete —
  const fnList = /^\/vms\/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])\/supabase\/functions\/deployed$/.exec(u.pathname);
  if (fnList && req.method === "GET") {
    try {
      return await supabaseAdmin.functionsListDeployed(req, res, { slug: fnList[1] });
    } catch (e) { return json(res, e.status || 500, { error: e.message }); }
  }
  const fnDeploy = /^\/vms\/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])\/supabase\/functions\/deploy$/.exec(u.pathname);
  if (fnDeploy && req.method === "POST") {
    try {
      return await supabaseAdmin.functionDeploy(req, res, { slug: fnDeploy[1], body: await readBodyOr(req) });
    } catch (e) { return json(res, e.status || 500, { error: e.message }); }
  }
  const fnOne = /^\/vms\/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])\/supabase\/functions\/([a-z][a-z0-9_-]{0,63})$/.exec(u.pathname);
  if (fnOne) {
    const vSlug = fnOne[1];
    const params = { name: fnOne[2] };
    try {
      if (req.method === "DELETE")              return await supabaseAdmin.functionDelete(req, res, { slug: vSlug, params });
    } catch (e) { return json(res, e.status || 500, { error: e.message }); }
  }
  const fnSrc = /^\/vms\/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])\/supabase\/functions\/([a-z][a-z0-9_-]{0,63})\/source$/.exec(u.pathname);
  if (fnSrc && req.method === "GET") {
    try {
      return await supabaseAdmin.functionSource(req, res, { slug: fnSrc[1], params: { name: fnSrc[2] } });
    } catch (e) { return json(res, e.status || 500, { error: e.message }); }
  }

  // — Migration Wizard —
  const migInv = /^\/vms\/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])\/migrate\/inventory$/.exec(u.pathname);
  if (migInv && req.method === "POST") {
    try {
      return await migrate.inventory(req, res, { slug: migInv[1], body: await readBodyOr(req) });
    } catch (e) { return json(res, e.status || 500, { error: e.message }); }
  }
  const migRun = /^\/vms\/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])\/migrate\/run$/.exec(u.pathname);
  if (migRun && req.method === "POST") {
    try {
      return await migrate.runStart(req, res, { slug: migRun[1], body: await readBodyOr(req) });
    } catch (e) { return json(res, e.status || 500, { error: e.message }); }
  }
  const migStream = /^\/vms\/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])\/migrate\/stream\/([0-9a-f-]{36})$/.exec(u.pathname);
  if (migStream && req.method === "GET") {
    try {
      return migrate.stream(req, res, { slug: migStream[1], params: { job_id: migStream[2] } });
    } catch (e) { return json(res, e.status || 500, { error: e.message }); }
  }
  const migCancel = /^\/vms\/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])\/migrate\/cancel\/([0-9a-f-]{36})$/.exec(u.pathname);
  if (migCancel && req.method === "POST") {
    try {
      return migrate.cancel(req, res, { slug: migCancel[1], params: { job_id: migCancel[2] } });
    } catch (e) { return json(res, e.status || 500, { error: e.message }); }
  }

  // — Table editor: CREATE TABLE collection POST —
  const teC = /^\/vms\/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])\/db\/tables$/.exec(u.pathname);
  if (teC && req.method === "POST") {
    const vSlug = teC[1];
    try {
      return await supabaseAdmin.createTable(req, res, { slug: vSlug, body: await readBodyOr(req) });
    } catch (e) { return json(res, e.status || 500, { error: e.message }); }
  }

  // — Table editor: per-table info / patch / drop —
  const teT = /^\/vms\/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])\/db\/tables\/([A-Za-z_][A-Za-z0-9_]{0,62})$/.exec(u.pathname);
  if (teT) {
    const vSlug = teT[1];
    const params = { name: teT[2] };
    try {
      if (req.method === "DELETE")              return await supabaseAdmin.dropTable(req, res, { slug: vSlug, params });
      if (req.method === "PATCH" || req.method === "PUT") {
        return await supabaseAdmin.alterTable(req, res, { slug: vSlug, params, body: await readBodyOr(req) });
      }
    } catch (e) { return json(res, e.status || 500, { error: e.message }); }
  }

  const teI = /^\/vms\/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])\/db\/tables\/([A-Za-z_][A-Za-z0-9_]{0,62})\/info$/.exec(u.pathname);
  if (teI && req.method === "GET") {
    try {
      return await supabaseAdmin.tableInfo(req, res, { slug: teI[1], params: { table: teI[2] } });
    } catch (e) { return json(res, e.status || 500, { error: e.message }); }
  }

  // — Table editor: columns collection (POST add) —
  const teCC = /^\/vms\/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])\/db\/tables\/([A-Za-z_][A-Za-z0-9_]{0,62})\/columns$/.exec(u.pathname);
  if (teCC && req.method === "POST") {
    try {
      return await supabaseAdmin.addColumn(req, res, { slug: teCC[1], params: { table: teCC[2] }, body: await readBodyOr(req) });
    } catch (e) { return json(res, e.status || 500, { error: e.message }); }
  }

  // — Table editor: per-column PATCH / DELETE —
  const teCol = /^\/vms\/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])\/db\/tables\/([A-Za-z_][A-Za-z0-9_]{0,62})\/columns\/([A-Za-z_][A-Za-z0-9_]{0,62})$/.exec(u.pathname);
  if (teCol) {
    const vSlug = teCol[1];
    const params = { table: teCol[2], column: teCol[3] };
    try {
      if (req.method === "DELETE")              return await supabaseAdmin.dropColumn(req, res, { slug: vSlug, params });
      if (req.method === "PATCH" || req.method === "PUT") {
        return await supabaseAdmin.alterColumn(req, res, { slug: vSlug, params, body: await readBodyOr(req) });
      }
    } catch (e) { return json(res, e.status || 500, { error: e.message }); }
  }

  // — Table editor: row CRUD —
  const teR = /^\/vms\/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])\/db\/tables\/([A-Za-z_][A-Za-z0-9_]{0,62})\/rows$/.exec(u.pathname);
  if (teR) {
    const vSlug = teR[1];
    const params = { table: teR[2] };
    try {
      if (req.method === "POST")                return await supabaseAdmin.insertRow(req, res, { slug: vSlug, params, body: await readBodyOr(req) });
      if (req.method === "PATCH" || req.method === "PUT") {
        return await supabaseAdmin.updateRow(req, res, { slug: vSlug, params, body: await readBodyOr(req) });
      }
      if (req.method === "DELETE")              return await supabaseAdmin.deleteRow(req, res, { slug: vSlug, params, body: await readBodyOr(req) });
    } catch (e) { return json(res, e.status || 500, { error: e.message }); }
  }


  // — Tab aggregations —
  const tvM = /^\/vms\/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])\/(supabase\/connection|coolify\/(?:cron|webhooks|env))$/.exec(u.pathname);
  if (tvM && req.method === "GET") {
    const vSlug = tvM[1];
    const path = tvM[2];
    try {
      if (path === "supabase/connection") return await tabviews.supabaseConnection(req, res, { slug: vSlug });
      if (path === "coolify/cron")        return await tabviews.cronOverview(req, res,        { slug: vSlug });
      if (path === "coolify/webhooks")    return await tabviews.webhooksOverview(req, res,    { slug: vSlug });
      if (path === "coolify/env")         return await tabviews.envOverview(req, res,         { slug: vSlug });
    } catch (e) { return json(res, e.status || 500, { error: e.message }); }
  }


  // — /apps/{id}/env/import — bulk .env paste —
  const eiM = /^\/apps\/([0-9a-f-]{36})\/env\/import$/.exec(u.pathname);
  if (eiM && req.method === "POST") {
    if (!slug) return json(res, 400, { error: "missing slug", code: "missing_slug" });
    try {
      return await apps.envImport(req, res, { slug, params: { id: eiM[1] }, body: await readBodyOr(req) });
    } catch (e) { return json(res, e.status || 500, { error: e.message }); }
  }

  json(res, 404, { error: "not found" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`wcn-provisioner listening on :${PORT}`);
  console.log(`  scripts: ${SCRIPTS_DIR}`);
  console.log(`  logs:    ${LOG_DIR}`);
  reconcileOrphanedJobs();
});
