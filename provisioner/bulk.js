// T3 #30 — Bulk operations runner. Whitelist of named operations. v1
// runs all targets concurrently with a small parallelism cap; no
// staged rollout (5%/25%/100%) yet — that's v2.

const http = require("http");
const db = require("./db");

const PROVISIONER_BASE = process.env.PROVISIONER_INTERNAL_BASE || "http://127.0.0.1:9000";
const PROVISIONER_TOKEN = process.env.PROVISIONER_TOKEN;
const PARALLELISM = parseInt(process.env.BULK_PARALLELISM || "5", 10);

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
function bad(res, code, err, error_code = "bad_request") {
  json(res, code, { error: err, code: error_code });
}

// Whitelist of operations the runner can invoke. Each entry returns
// { method, pathTemplate, body? }. Path templates use {slug}.
const OPERATIONS = {
  "vm.restart":  { method: "POST", path: (slug) => `/vms/${slug}/restart`,  body: () => null },
  "vm.stop":     { method: "POST", path: (slug) => `/vms/${slug}/stop`,     body: () => null },
  "vm.start":    { method: "POST", path: (slug) => `/vms/${slug}/start`,    body: () => null },
  "vm.backup":   { method: "POST", path: (slug) => `/vms/${slug}/backups`,  body: () => null },
};

function callProvisioner(method, path, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${PROVISIONER_BASE}${path}`);
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers: {
        Authorization: `Bearer ${PROVISIONER_TOKEN}`,
        "Content-Type": "application/json",
        "x-wcn-actor": "bulk-runner",
        ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
      },
    }, (r) => {
      let buf = "";
      r.on("data", (c) => (buf += c));
      r.on("end", () => {
        let parsed;
        try { parsed = JSON.parse(buf); } catch { parsed = { raw: buf }; }
        resolve({ status: r.statusCode, body: parsed });
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function resolveTargets(filter) {
  // filter: { slugs?: [], tiers?: [], statuses?: [], exclude_slugs?: [] }
  const conds = ["status != 'destroyed'"];
  const params = [];
  let i = 0;
  if (Array.isArray(filter.slugs) && filter.slugs.length > 0) {
    conds.push(`slug = ANY($${++i}::text[])`); params.push(filter.slugs);
  }
  if (Array.isArray(filter.tiers) && filter.tiers.length > 0) {
    conds.push(`tier = ANY($${++i}::text[])`); params.push(filter.tiers);
  }
  if (Array.isArray(filter.statuses) && filter.statuses.length > 0) {
    conds.push(`status = ANY($${++i}::text[])`); params.push(filter.statuses);
  }
  if (Array.isArray(filter.exclude_slugs) && filter.exclude_slugs.length > 0) {
    conds.push(`slug <> ALL($${++i}::text[])`); params.push(filter.exclude_slugs);
  }
  return db.rowsJson(
    `SELECT row_to_json(t) FROM (SELECT slug FROM customers WHERE ${conds.join(" AND ")} ORDER BY slug) t`,
    params,
  );
}

// In-process runner. Updates DB as it goes; safe to crash and restart.
async function runJob(jobId) {
  const job = await db.oneJson(
    `SELECT row_to_json(t) FROM (
       SELECT id, operation, args, target_filter, dry_run FROM bulk_jobs WHERE id = $1
     ) t`,
    [jobId],
  );
  if (!job) return;
  const op = OPERATIONS[job.operation];

  await db.exec(`UPDATE bulk_jobs SET status = 'running', started_at = now() WHERE id = $1`, [jobId]);

  const targets = await resolveTargets(job.target_filter || {});
  for (const t of targets) {
    await db.exec(
      `INSERT INTO bulk_job_runs (job_id, customer_slug, status) VALUES ($1, $2, 'queued')
       ON CONFLICT (job_id, customer_slug) DO NOTHING`,
      [jobId, t.slug],
    );
  }

  let inFlight = 0;
  let cursor = 0;
  let abortDetected = false;

  async function runOne(slug) {
    const startedAt = new Date().toISOString();
    await db.exec(
      `UPDATE bulk_job_runs SET status = 'running', started_at = $3 WHERE job_id = $1 AND customer_slug = $2`,
      [jobId, slug, startedAt],
    );
    let outcome;
    try {
      if (job.dry_run) {
        outcome = { status: "succeeded", result: { dry_run: true, would_call: `${op.method} ${op.path(slug)}` } };
      } else {
        const result = await callProvisioner(op.method, op.path(slug), op.body ? op.body(job.args) : null);
        const ok = result.status >= 200 && result.status < 300;
        outcome = {
          status: ok ? "succeeded" : "failed",
          result: { http_status: result.status, body: result.body },
        };
      }
    } catch (e) {
      outcome = { status: "failed", result: { error: e.message } };
    }
    await db.exec(
      `UPDATE bulk_job_runs SET status = $3, result = $4::jsonb, finished_at = now()
       WHERE job_id = $1 AND customer_slug = $2`,
      [jobId, slug, outcome.status, JSON.stringify(outcome.result)],
    );
  }

  await new Promise((resolveAll) => {
    function next() {
      if (abortDetected) {
        if (inFlight === 0) resolveAll();
        return;
      }
      while (inFlight < PARALLELISM && cursor < targets.length) {
        const slug = targets[cursor++].slug;
        inFlight++;
        runOne(slug).finally(() => {
          inFlight--;
          // poll for abort flag occasionally
          db.oneJson(
            `SELECT row_to_json(t) FROM (SELECT abort_requested FROM bulk_jobs WHERE id = $1) t`,
            [jobId],
          ).then((j) => {
            if (j && j.abort_requested) abortDetected = true;
            if (cursor >= targets.length && inFlight === 0) resolveAll();
            else next();
          }).catch(() => next());
        });
      }
      if (cursor >= targets.length && inFlight === 0) resolveAll();
    }
    next();
  });

  // Determine final status
  const stats = await db.oneJson(
    `SELECT row_to_json(t) FROM (
       SELECT
         COUNT(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
         COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
         COUNT(*) FILTER (WHERE status = 'queued')::int AS queued
       FROM bulk_job_runs WHERE job_id = $1
     ) t`,
    [jobId],
  );
  let finalStatus = "succeeded";
  if (abortDetected) finalStatus = "aborted";
  else if (stats.failed > 0 && stats.succeeded > 0) finalStatus = "partial";
  else if (stats.failed > 0) finalStatus = "failed";
  await db.exec(
    `UPDATE bulk_jobs SET status = $2, finished_at = now() WHERE id = $1`,
    [jobId, finalStatus],
  );
}

// POST /admin/bulk { operation, args?, target_filter, dry_run? }
async function create(req, res, { body }) {
  const operation = String(body.operation || "");
  if (!OPERATIONS[operation]) {
    return bad(res, 400, `unknown operation; allowed: ${Object.keys(OPERATIONS).join(", ")}`, "unknown_op");
  }
  const target_filter = (body.target_filter && typeof body.target_filter === "object") ? body.target_filter : {};
  const dry_run = !!body.dry_run;
  const actor = (req.headers["x-wcn-actor"] || "system").toString().slice(0, 120);

  // Preview targets so the response includes the count even if the run takes a while.
  const targets = await resolveTargets(target_filter);

  const row = await db.oneJson(
    `WITH ins AS (
       INSERT INTO bulk_jobs (actor, operation, args, target_filter, dry_run)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)
       RETURNING id, status, created_at
     )
     SELECT row_to_json(t) FROM ins t`,
    [actor, operation, JSON.stringify(body.args || {}), JSON.stringify(target_filter), dry_run],
  );

  await db.exec(
    `INSERT INTO audit_log (actor, action, slug, details)
     VALUES ($1, 'bulk.create', NULL, $2)`,
    [actor, `op=${operation} dry_run=${dry_run} target_count=${targets.length}`],
  );

  // Fire and forget — the runner updates the DB.
  setImmediate(() => runJob(row.id).catch((e) => console.error("[bulk] run failed:", e.message)));

  json(res, 202, {
    id: row.id,
    status: row.status,
    operation,
    dry_run,
    target_count: targets.length,
    targets: targets.map((t) => t.slug),
  });
}

// GET /admin/bulk?limit=
async function list(req, res, { query }) {
  const limit = Math.min(parseInt(query.limit || "20", 10) || 20, 100);
  const rows = await db.rowsJson(
    `SELECT row_to_json(t) FROM (
       SELECT b.*,
         (SELECT json_agg(json_build_object(
           'slug', r.customer_slug, 'status', r.status,
           'started_at', r.started_at, 'finished_at', r.finished_at
         ) ORDER BY r.customer_slug) FROM bulk_job_runs r WHERE r.job_id = b.id) AS runs
       FROM bulk_jobs b ORDER BY b.created_at DESC LIMIT ${limit}
     ) t`,
  );
  json(res, 200, rows);
}

// GET /admin/bulk/{id}
async function get(req, res, { params }) {
  const id = parseInt(params.id, 10);
  if (!Number.isInteger(id) || id < 1) return bad(res, 400, "invalid id", "invalid_id");
  const job = await db.oneJson(
    `SELECT row_to_json(t) FROM (
       SELECT b.*,
         (SELECT json_agg(json_build_object(
           'slug', r.customer_slug, 'status', r.status, 'result', r.result,
           'started_at', r.started_at, 'finished_at', r.finished_at
         ) ORDER BY r.customer_slug) FROM bulk_job_runs r WHERE r.job_id = b.id) AS runs
       FROM bulk_jobs b WHERE b.id = $1
     ) t`,
    [id],
  );
  if (!job) return bad(res, 404, "job not found", "not_found");
  json(res, 200, job);
}

// POST /admin/bulk/{id}/abort
async function abort(req, res, { params }) {
  const id = parseInt(params.id, 10);
  if (!Number.isInteger(id) || id < 1) return bad(res, 400, "invalid id", "invalid_id");
  await db.exec(
    `UPDATE bulk_jobs SET abort_requested = true WHERE id = $1 AND status IN ('pending','running')`,
    [id],
  );
  await db.exec(
    `INSERT INTO audit_log (actor, action, slug, details) VALUES ($1, 'bulk.abort', NULL, $2)`,
    [(req.headers["x-wcn-actor"] || "system").toString().slice(0, 120), `job_id=${id}`],
  );
  json(res, 200, { ok: true, abort_requested: true });
}

module.exports = { create, list, get, abort };
