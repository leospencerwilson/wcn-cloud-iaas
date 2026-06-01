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
const apps = require("./apps");

function readBodyOr(req) {
  return readBody(req).catch(() => ({}));
}

// Validate ?slug= or X-Wcn-Customer-Slug header against SLUG_RE
function slugFromReq(req, parsedUrl) {
  const fromQuery = parsedUrl.searchParams.get("slug");
  const fromHdr   = req.headers["x-wcn-customer-slug"];
  const slug = fromQuery || fromHdr || "";
  return SLUG_RE.test(slug) ? slug : null;
}

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

const server = http.createServer(async (req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
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

  // GET /jobs/:id  or  GET /jobs/:id/stream  or  GET /jobs/:id/log
  const m = /^\/jobs\/([0-9a-f-]{36})(\/stream|\/log)?$/.exec(req.url || "");
  if (m && req.method === "GET") {
    const job = jobs.get(m[1]);
    if (!job) return json(res, 404, { error: "not found" });
    if (m[2] === "/stream") return streamLog(req, res, job);
    if (m[2] === "/log") {
      fs.readFile(job.logPath, "utf8", (err, data) => {
        if (err) {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("");
          return;
        }
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(data);
      });
      return;
    }
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

  // POST /jobs/:id/cancel
  const mc = /^\/jobs\/([0-9a-f-]{36})\/cancel$/.exec(req.url || "");
  if (mc && req.method === "POST") {
    const job = jobs.get(mc[1]);
    if (!job) return json(res, 404, { error: "not found" });
    if (job.status === "queued") {
      const idx = queue.indexOf(job);
      if (idx >= 0) queue.splice(idx, 1);
      job.status = "failed";
      job.exitCode = -1;
      job.finishedAt = new Date().toISOString();
      return json(res, 200, { ok: true, cancelled: "queued" });
    }
    if (job.status === "running" && job.proc) {
      try {
        job.proc.kill("SIGTERM");
      } catch (e) {}
      return json(res, 200, { ok: true, cancelled: "running" });
    }
    return json(res, 409, { error: "not cancellable", status: job.status });
  }

  // — /apps/* —
  const u = new URL(req.url || "/", "http://localhost");
  const m1 = /^\/apps\/?$/.exec(u.pathname);
  const m2 = /^\/apps\/([0-9a-f-]{36})$/.exec(u.pathname);
  const m3 = /^\/apps\/([0-9a-f-]{36})\/(deploy|deployments|logs|env)$/.exec(u.pathname);
  const m4 = /^\/apps\/([0-9a-f-]{36})\/domains\/?$/.exec(u.pathname);
  const m5 = /^\/apps\/([0-9a-f-]{36})\/domains\/([^\/]+)$/.exec(u.pathname);

  const slug = slugFromReq(req, u);
  const query = Object.fromEntries(u.searchParams);

  try {
    if (m1 && req.method === "GET") {
      if (!slug) return json(res, 400, { error: "missing slug", code: "missing_slug" });
      return apps.list(req, res, { slug, query });
    }
    if (m1 && req.method === "POST") {
      if (!slug) return json(res, 400, { error: "missing slug", code: "missing_slug" });
      const body = await readBodyOr(req);
      return apps.create(req, res, { slug, body });
    }
    if (m2) {
      const params = { id: m2[1] };
      if (!slug) return json(res, 400, { error: "missing slug", code: "missing_slug" });
      if (req.method === "GET")    return apps.get(req, res,    { slug, params });
      if (req.method === "PATCH")  return apps.patch(req, res,  { slug, params, body: await readBodyOr(req) });
      if (req.method === "DELETE") return apps.delete(req, res, { slug, params });
    }
    if (m3) {
      const params = { id: m3[1] }, action = m3[2];
      if (!slug) return json(res, 400, { error: "missing slug", code: "missing_slug" });
      if (action === "deploy"      && req.method === "POST") return apps.deploy(req, res,      { slug, params, body: await readBodyOr(req) });
      if (action === "deployments" && req.method === "GET")  return apps.deployments(req, res, { slug, params });
      if (action === "logs"        && req.method === "GET")  return apps.logs(req, res,        { slug, params, query });
      if (action === "env"         && req.method === "GET")  return apps.envGet(req, res,      { slug, params });
      if (action === "env"         && req.method === "PUT")  return apps.envPut(req, res,      { slug, params, body: await readBodyOr(req) });
    }
    if (m4) {
      const params = { id: m4[1] };
      if (!slug) return json(res, 400, { error: "missing slug", code: "missing_slug" });
      if (req.method === "GET")  return apps.domainsList(req, res, { slug, params });
      if (req.method === "POST") return apps.domainAdd(req, res,   { slug, params, body: await readBodyOr(req) });
    }
    if (m5) {
      const params = { id: m5[1], hostname: decodeURIComponent(m5[2]) };
      if (!slug) return json(res, 400, { error: "missing slug", code: "missing_slug" });
      if (req.method === "GET")    return apps.domainStatus(req, res, { slug, params });
      if (req.method === "DELETE") return apps.domainDelete(req, res, { slug, params });
    }
  } catch (e) {
    return json(res, e.status || 500, { error: e.message, code: e.code || "internal_error" });
  }

  json(res, 404, { error: "not found" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`wcn-provisioner listening on :${PORT}`);
  console.log(`  scripts: ${SCRIPTS_DIR}`);
  console.log(`  logs:    ${LOG_DIR}`);
});
