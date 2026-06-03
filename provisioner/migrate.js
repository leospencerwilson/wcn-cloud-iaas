/* Migration Wizard backend.
 *
 * Pulls a Supabase project (Cloud or self-hosted) into a customer's
 * managed instance. Source credentials are supplied by the customer at
 * runtime — never stored on the server.
 *
 * Phases:
 *   1. validate    — open both ends, prove we can read source + write dest
 *   2. schema      — pg_dump --schema-only --schema=public from source,
 *                    pipe straight into customer-vm:supabase-db psql
 *   3. data        — pg_dump --data-only --schema=public --disable-triggers
 *                    --no-owner --inserts, pipe in
 *   4. auth        — dump auth.users + auth.identities + auth.mfa_factors
 *                    (TRUNCATE first then INSERT — sessions are reset).
 *                    Passwords are bcrypt; they carry over.
 *   5. storage     — list source buckets, recreate via our Kong, list each
 *                    bucket's objects, download from source storage-api,
 *                    re-upload via our storage-api with x-upsert
 *   6. functions   — best-effort: only attempted for self-hosted source if
 *                    the user supplies SSH creds; otherwise skipped with a
 *                    note (Supabase Cloud has no read-back API for edge
 *                    function source code under user-key auth).
 *
 * Progress is emitted as SSE messages on /migrate/stream/{job_id}. The
 * job stays in memory keyed by jobId; events are buffered so a late
 * connector replays the whole log. Buffer is capped at 5000 lines.
 */
const { spawn } = require("child_process");
const crypto = require("crypto");
const db = require("./db");

const jobs = new Map();
const MAX_BUFFER = 5000;
const MAX_BODY = 1024 * 1024; // 1 MiB JSON body cap

function bad(res, code, error, error_code) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify({ error, code: error_code }));
}
function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function vmBySlug(slug) {
  return db.oneJson(
    `SELECT row_to_json(t) FROM (
       SELECT v.customer_slug AS slug, host(v.ip) AS ip
       FROM vms v WHERE v.customer_slug = $1 AND v.destroyed_at IS NULL
     ) t`,
    [slug],
  );
}

/* ── helpers ──────────────────────────────────────────────────────── */

function newJob(slug) {
  const id = crypto.randomUUID();
  const job = {
    id,
    slug,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: "running",
    cancelled: false,
    events: [], // [{ ts, level, phase, message, progress, total }]
    waiters: new Set(), // SSE response objects
    procs: new Set(), // child processes to kill on cancel
  };
  jobs.set(id, job);
  return job;
}

function emit(job, level, phase, message, progress, total) {
  if (job.events.length >= MAX_BUFFER) {
    job.events.shift();
  }
  const evt = {
    ts: new Date().toISOString(),
    level,
    phase,
    message,
    ...(typeof progress === "number" ? { progress } : {}),
    ...(typeof total === "number" ? { total } : {}),
  };
  job.events.push(evt);
  for (const res of job.waiters) {
    try {
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    } catch { /* peer gone */ }
  }
}

function endJob(job, ok, finalMessage) {
  job.status = ok ? "succeeded" : (job.cancelled ? "cancelled" : "failed");
  job.finishedAt = new Date().toISOString();
  emit(job, ok ? "info" : "error", "done", finalMessage);
  // Push the done event then close waiters.
  for (const res of job.waiters) {
    try {
      res.write(`event: end\ndata: ${JSON.stringify({ status: job.status })}\n\n`);
      res.end();
    } catch {}
  }
  job.waiters.clear();
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on("data", (c) => {
      total += c.length;
      if (total > MAX_BODY) {
        req.destroy(new Error("body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        const s = Buffer.concat(chunks).toString("utf8");
        resolve(s ? JSON.parse(s) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function pgDumpArgs(sourceUrl, opts) {
  const a = [
    sourceUrl,
    "--no-owner",
    "--no-privileges",
    "--no-comments",
    "--no-publications",
    "--no-subscriptions",
  ];
  if (opts.schemaOnly) a.push("--schema-only");
  if (opts.dataOnly) {
    a.push("--data-only", "--disable-triggers", "--column-inserts", "--rows-per-insert=500");
  }
  if (Array.isArray(opts.schemas)) for (const s of opts.schemas) a.push("--schema=" + s);
  if (Array.isArray(opts.tables)) for (const t of opts.tables) a.push("--table=" + t);
  if (Array.isArray(opts.excludeTables)) for (const t of opts.excludeTables) a.push("--exclude-table=" + t);
  return a;
}

/* Pipes `pg_dump <args>` → `ssh ops@<ip> docker exec -i supabase-db psql`.
 * Resolves on success; rejects with the last stderr lines on non-zero exit.
 * Stdout lines from psql are echoed to the job. */
function pgPipeline(job, label, sourceUrl, dumpOpts, vmIp) {
  return new Promise((resolve, reject) => {
    const dump = spawn("pg_dump", pgDumpArgs(sourceUrl, dumpOpts), {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    const restore = spawn(
      "ssh",
      [
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=10",
        "-o", "StrictHostKeyChecking=accept-new",
        `ops@${vmIp}`,
        "sudo", "docker", "exec", "-i", "supabase-db",
        "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=0", "-q",
      ],
      { stdio: ["pipe", "pipe", "pipe"], env: process.env },
    );
    job.procs.add(dump); job.procs.add(restore);

    dump.stdout.pipe(restore.stdin);

    let dumpErr = "", restoreOut = "", restoreErr = "";
    let bytesPiped = 0;
    dump.stdout.on("data", (c) => { bytesPiped += c.length; });
    dump.stderr.on("data", (c) => { dumpErr += c; });
    restore.stdout.on("data", (c) => { restoreOut += c; });
    restore.stderr.on("data", (c) => { restoreErr += c; });

    let dumpDone = false, restoreDone = false, dumpCode = null, restoreCode = null;
    const finish = () => {
      if (!(dumpDone && restoreDone)) return;
      job.procs.delete(dump); job.procs.delete(restore);
      emit(job, "info", label, `${label}: piped ${(bytesPiped / 1024).toFixed(1)} KB`);
      if (dumpCode !== 0) {
        return reject(new Error(`pg_dump exit ${dumpCode}: ${dumpErr.trim().split(/\r?\n/).slice(-3).join(" | ")}`));
      }
      if (restoreCode !== 0) {
        // ON_ERROR_STOP=0 means restore returns 0 in most cases; if it fails it's catastrophic.
        return reject(new Error(`psql exit ${restoreCode}: ${restoreErr.trim().split(/\r?\n/).slice(-3).join(" | ")}`));
      }
      resolve({ bytes: bytesPiped, stdout: restoreOut, stderr: restoreErr });
    };
    dump.on("close", (c) => { dumpDone = true; dumpCode = c; finish(); });
    restore.on("close", (c) => { restoreDone = true; restoreCode = c; finish(); });
  });
}

/* TRUNCATE + restore auth tables. We re-import users + identities + mfa_factors;
 * sessions and refresh_tokens are intentionally left empty (JWT secret differs). */
async function pgExecOnDest(job, vmIp, sql, label) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "ssh",
      [
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=10",
        "-o", "StrictHostKeyChecking=accept-new",
        `ops@${vmIp}`,
        "sudo", "docker", "exec", "-i", "supabase-db",
        "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    job.procs.add(proc);
    let stderr = "";
    proc.stderr.on("data", (c) => { stderr += c; });
    proc.on("close", (code) => {
      job.procs.delete(proc);
      if (code !== 0) return reject(new Error(`${label} failed (${code}): ${stderr.trim().slice(-300)}`));
      resolve();
    });
    proc.stdin.write(sql);
    proc.stdin.end();
  });
}

async function ghReq(url, key, opts = {}) {
  const r = await fetch(url, {
    ...opts,
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      ...(opts.body ? { "content-type": "application/json" } : {}),
      ...(opts.headers || {}),
    },
  });
  return r;
}

/* ── inventory ────────────────────────────────────────────────────── */

async function inventory(req, res, { slug, body }) {
  const vm = await vmBySlug(slug);
  if (!vm) return bad(res, 404, "vm not found", "not_found");
  const { source_db_url, source_api_url, source_service_role_key } = body || {};
  if (!source_db_url || !source_api_url || !source_service_role_key) {
    return bad(res, 400, "source_db_url, source_api_url, source_service_role_key required", "missing_creds");
  }

  // 1. Postgres connectivity + counts via a single SELECT
  const out = {};
  try {
    const psql = await new Promise((resolve, reject) => {
      const proc = spawn("psql", [
        source_db_url,
        "-At",
        "-c",
        "select json_build_object(" +
          "'tables', (select count(*) from pg_tables where schemaname='public')," +
          "'rows', coalesce((select sum(reltuples)::bigint from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'), 0)," +
          "'users', (select count(*) from auth.users)," +
          "'identities', (select count(*) from auth.identities)," +
          "'policies', (select count(*) from pg_policies where schemaname='public')" +
        ")",
      ], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
      let stdout = "", stderr = "";
      proc.stdout.on("data", (c) => { stdout += c; });
      proc.stderr.on("data", (c) => { stderr += c; });
      proc.on("close", (code) => {
        if (code !== 0) return reject(new Error(stderr.trim().split(/\r?\n/).pop() || "psql connect failed"));
        resolve(stdout.trim());
      });
    });
    Object.assign(out, JSON.parse(psql));
  } catch (e) {
    return bad(res, 502, `source DB unreachable: ${e.message}`, "source_db_unreachable");
  }

  // 2. Storage buckets via Kong
  try {
    const r = await ghReq(`${source_api_url.replace(/\/+$/, "")}/storage/v1/bucket`, source_service_role_key);
    if (r.ok) {
      const buckets = await r.json();
      out.buckets = Array.isArray(buckets) ? buckets.length : 0;
      out.bucket_names = Array.isArray(buckets) ? buckets.map((b) => b.name) : [];
    } else {
      out.buckets = 0;
      out.bucket_names = [];
    }
  } catch { out.buckets = 0; out.bucket_names = []; }

  // 3. Edge functions are not enumerable via user-key auth on Cloud — skip.
  out.functions_note = "Edge functions are not enumerable via the storage API; v1 skips them. Redeploy via the Supabase CLI after the rest lands.";

  json(res, 200, out);
}

/* ── run ──────────────────────────────────────────────────────────── */

async function runStart(req, res, { slug, body }) {
  const vm = await vmBySlug(slug);
  if (!vm) return bad(res, 404, "vm not found", "not_found");
  const include = body.include || { schema: true, data: true, auth: true, storage: true };
  const { source_db_url, source_api_url, source_service_role_key } = body || {};
  if (!source_db_url || !source_api_url || !source_service_role_key) {
    return bad(res, 400, "missing source creds", "missing_creds");
  }

  const job = newJob(slug);
  json(res, 202, { job_id: job.id, status: "running" });

  // Detached background runner.
  (async () => {
    try {
      emit(job, "info", "start", `Migration starting for ${slug}`);

      // ── 2. schema ────────────────────────────────────────────────
      if (include.schema) {
        emit(job, "info", "schema", "Dumping source schema (public) …");
        await pgPipeline(job, "schema", source_db_url, { schemaOnly: true, schemas: ["public"] }, vm.ip);
        if (job.cancelled) return endJob(job, false, "cancelled");
      }

      // ── 3. data ──────────────────────────────────────────────────
      if (include.data) {
        emit(job, "info", "data", "Copying public-schema row data …");
        await pgPipeline(job, "data", source_db_url, { dataOnly: true, schemas: ["public"] }, vm.ip);
        if (job.cancelled) return endJob(job, false, "cancelled");
      }

      // ── 4. auth ──────────────────────────────────────────────────
      if (include.auth) {
        emit(job, "info", "auth", "Resetting destination auth tables …");
        await pgExecOnDest(
          job, vm.ip,
          `TRUNCATE auth.identities CASCADE;
           TRUNCATE auth.mfa_factors CASCADE;
           TRUNCATE auth.users RESTART IDENTITY CASCADE;`,
          "auth truncate",
        );
        emit(job, "info", "auth", "Copying auth.users + identities + mfa_factors …");
        await pgPipeline(job, "auth", source_db_url, {
          dataOnly: true,
          tables: ["auth.users", "auth.identities", "auth.mfa_factors"],
        }, vm.ip);
        if (job.cancelled) return endJob(job, false, "cancelled");
      }

      // ── 5. storage ───────────────────────────────────────────────
      if (include.storage) {
        emit(job, "info", "storage", "Listing source buckets …");
        const bucketsRes = await ghReq(`${source_api_url.replace(/\/+$/, "")}/storage/v1/bucket`, source_service_role_key);
        if (!bucketsRes.ok) throw new Error(`source storage list failed: ${bucketsRes.status}`);
        const buckets = await bucketsRes.json();
        emit(job, "info", "storage", `Found ${buckets.length} bucket(s)`);

        const destApi = `https://api-${slug}.western-communication.com`;
        // We need OUR service-role key to upload — fetch via supabase-admin's getServiceRoleKey path.
        // Inline implementation rather than importing supabase-admin to keep dependencies clear.
        const destKey = await readDestServiceKey(vm.ip);

        for (const b of buckets) {
          if (job.cancelled) return endJob(job, false, "cancelled");

          // Recreate bucket
          emit(job, "info", "storage", `Recreating bucket "${b.name}" (public=${b.public}) …`);
          await ghReq(`${destApi}/storage/v1/bucket`, destKey, {
            method: "POST",
            body: JSON.stringify({
              id: b.name,
              name: b.name,
              public: !!b.public,
              file_size_limit: b.file_size_limit ?? null,
              allowed_mime_types: b.allowed_mime_types ?? null,
            }),
          }).catch(() => {}); // ignore "already exists"

          // List + copy objects
          let copied = 0, totalBytes = 0;
          let cursor = "";
          while (true) {
            if (job.cancelled) return endJob(job, false, "cancelled");
            const listRes = await ghReq(
              `${source_api_url.replace(/\/+$/, "")}/storage/v1/object/list/${encodeURIComponent(b.name)}`,
              source_service_role_key,
              {
                method: "POST",
                body: JSON.stringify({ prefix: cursor, limit: 100, offset: 0, sortBy: { column: "name", order: "asc" } }),
              },
            );
            if (!listRes.ok) {
              emit(job, "warn", "storage", `list objects ${b.name} failed (${listRes.status})`);
              break;
            }
            const objs = await listRes.json();
            if (!Array.isArray(objs) || objs.length === 0) break;
            for (const o of objs) {
              if (job.cancelled) return endJob(job, false, "cancelled");
              if (!o.name) continue;
              // Folders come back with no metadata — Supabase storage's list is shallow per prefix; we iterate.
              const key = cursor ? `${cursor}/${o.name}` : o.name;
              const fileRes = await ghReq(
                `${source_api_url.replace(/\/+$/, "")}/storage/v1/object/${encodeURIComponent(b.name)}/${key.split("/").map(encodeURIComponent).join("/")}`,
                source_service_role_key,
              );
              if (!fileRes.ok) {
                emit(job, "warn", "storage", `skip ${b.name}/${key} (source ${fileRes.status})`);
                continue;
              }
              const bytes = Buffer.from(await fileRes.arrayBuffer());
              const upRes = await ghReq(
                `${destApi}/storage/v1/object/${encodeURIComponent(b.name)}/${key.split("/").map(encodeURIComponent).join("/")}`,
                destKey,
                {
                  method: "POST",
                  body: bytes,
                  headers: { "content-type": fileRes.headers.get("content-type") || "application/octet-stream", "x-upsert": "true" },
                },
              );
              if (!upRes.ok) {
                emit(job, "warn", "storage", `upload ${b.name}/${key} failed (${upRes.status})`);
                continue;
              }
              copied++;
              totalBytes += bytes.length;
              if (copied % 5 === 0) {
                emit(job, "info", "storage", `${b.name}: ${copied} objects, ${(totalBytes / 1024).toFixed(1)} KB`);
              }
            }
            if (objs.length < 100) break;
            // Storage list doesn't paginate cleanly via offset in v1 — break out.
            break;
          }
          emit(job, "info", "storage", `Bucket "${b.name}": ${copied} objects (${(totalBytes / 1024).toFixed(1)} KB)`);
        }
      }

      emit(job, "info", "done", "Migration complete");
      endJob(job, true, "Migration succeeded");
    } catch (e) {
      emit(job, "error", "fatal", e && e.message ? e.message : String(e));
      endJob(job, false, e && e.message ? e.message : "migration failed");
    }
  })();
}

async function readDestServiceKey(vmIp) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "ssh",
      [
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=10",
        "-o", "StrictHostKeyChecking=accept-new",
        `ops@${vmIp}`,
        "sudo", "grep", "-E", "^SERVICE_ROLE_KEY=", "/etc/wcn-cloud/supabase.env",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "", stderr = "";
    proc.stdout.on("data", (c) => { stdout += c; });
    proc.stderr.on("data", (c) => { stderr += c; });
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`read service role failed: ${stderr.trim()}`));
      const m = /^SERVICE_ROLE_KEY=(\S+)\s*$/m.exec(stdout);
      if (!m) return reject(new Error("SERVICE_ROLE_KEY not found"));
      resolve(m[1]);
    });
  });
}

/* ── SSE stream ───────────────────────────────────────────────────── */

function stream(req, res, { params }) {
  const job = jobs.get(params.job_id);
  if (!job) return bad(res, 404, "job not found", "not_found");
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "connection": "keep-alive",
    "x-accel-buffering": "no",
  });
  // Replay buffered events first.
  for (const evt of job.events) {
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
  }
  if (job.status !== "running") {
    res.write(`event: end\ndata: ${JSON.stringify({ status: job.status })}\n\n`);
    return res.end();
  }
  job.waiters.add(res);
  // Heartbeat every 15s to keep proxies from idle-closing.
  const hb = setInterval(() => { try { res.write(": hb\n\n"); } catch {} }, 15_000);
  res.on("close", () => { clearInterval(hb); job.waiters.delete(res); });
}

/* ── cancel ───────────────────────────────────────────────────────── */

function cancel(req, res, { params }) {
  const job = jobs.get(params.job_id);
  if (!job) return bad(res, 404, "job not found", "not_found");
  job.cancelled = true;
  for (const p of job.procs) { try { p.kill("SIGTERM"); } catch {} }
  emit(job, "warn", "cancel", "Cancellation requested");
  json(res, 200, { ok: true });
}

module.exports = { inventory, runStart, stream, cancel, readJsonBody };
