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
const bulk = require("./bulk");
const webhooks = require("./webhooks");
const dbquery = require("./dbquery");
const tabviews = require("./tabviews");
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

function enqueue(kind, slug, extraArgs = []) {
  const jobId = randomUUID();
  const logPath = path.join(LOG_DIR, `${jobId}.log`);
  const job = {
    jobId,
    kind,
    slug,
    args: extraArgs,
    status: "queued",
    exitCode: null,
    startedAt: null,
    finishedAt: null,
    logPath,
    proc: null,
  };
  jobs.set(jobId, job);
  queue.push(job);
  drain();
  return job;
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

  const args = ["--slug", job.slug, ...job.args];
  const proc = spawn(scriptPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  job.proc = proc;

  proc.stdout.on("data", (c) => logStream.write(c));
  proc.stderr.on("data", (c) => logStream.write(c));

  proc.on("error", (err) => {
    logStream.write(`\n[receiver] spawn error: ${err.message}\n`);
  });

  proc.on("close", (code) => {
    job.status = code === 0 ? "succeeded" : "failed";
    job.exitCode = code;
    job.finishedAt = new Date().toISOString();
    job.proc = null;
    logStream.end(`\n── exit ${code} at ${job.finishedAt}\n`);
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

  // GET /jobs/:id  or  GET /jobs/:id/stream
  const m = /^\/jobs\/([0-9a-f-]{36})(\/stream)?$/.exec(req.url || "");
  if (m && req.method === "GET") {
    const job = jobs.get(m[1]);
    if (!job) return json(res, 404, { error: "not found" });
    if (m[2]) return streamLog(req, res, job);
    return json(res, 200, {
      jobId: job.jobId,
      kind: job.kind,
      slug: job.slug,
      status: job.status,
      exitCode: job.exitCode,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    });
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
        if (query.follow === "true") return await apps.streamRuntimeLogs(req, res, { slug, params, query });
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


  // — /vms/{slug}/* —
  const vmm1 = /^\/vms\/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])\/(power|restart|stop|start|backups|resize|snapshots|metrics|backup-policy)\/?$/.exec(u.pathname);
  if (vmm1) {
    const vSlug = vmm1[1];
    const action = vmm1[2];
    try {
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
  const dbM = /^\/vms\/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])\/db\/(query|tables|columns|sizes)$/.exec(u.pathname);
  if (dbM) {
    const vSlug = dbM[1];
    const action = dbM[2];
    try {
      if (action === "query"   && req.method === "POST") return await dbquery.query(req, res,   { slug: vSlug, body: await readBodyOr(req) });
      if (action === "tables"  && req.method === "GET")  return await dbquery.tables(req, res,  { slug: vSlug });
      if (action === "columns" && req.method === "GET")  return await dbquery.columns(req, res, { slug: vSlug, query });
      if (action === "sizes"   && req.method === "GET")  return await dbquery.sizes(req, res,   { slug: vSlug });
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
});
