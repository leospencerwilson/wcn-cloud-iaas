// HTTP handlers for /apps/* endpoints. Each handler receives (req, res, ctx)
// where ctx has { slug, params, body, query } already parsed by server.js.

const db = require("./db");
const { spawn } = require("child_process");
const coolify = require("./coolify");
const domains = require("./domains");

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

// Resolve the actual docker container name on the customer VM for a
// given Coolify application UUID. Coolify names application containers
// `<coolify_app_uuid>-<deployment_id>`, which the public API doesn't
// reliably surface — querying `/applications/{uuid}` returns no
// `container_name` field, and the historical fallback `${name}-${uuid}`
// was wrong (the parts are swapped). We do a one-shot SSH `docker ps`
// filter to find the live container.
function resolveContainerName(vmIp, coolifyAppUuid) {
  return new Promise((resolve) => {
    const out = [];
    const proc = spawn(
      "ssh",
      [
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", "ConnectTimeout=10",
        `ops@${vmIp}`,
        "sudo", "docker", "ps",
        "--filter", `name=${coolifyAppUuid}`,
        "--format", "{{.Names}}",
        "--latest",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    proc.stdout.on("data", (d) => out.push(d.toString()));
    proc.on("close", (code) => {
      if (code !== 0) return resolve(null);
      const name = out.join("").trim().split("\n")[0];
      resolve(name || null);
    });
  });
}

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
function bad(res, code, err, error_code = "bad_request") {
  json(res, code, { error: err, code: error_code });
}

async function appBySlugAndId(slug, id) {
  return db.oneJson(`
    SELECT row_to_json(t) FROM (
      SELECT a.* FROM apps a WHERE a.customer_slug = $1 AND a.id = $2
    ) t
  `, [slug, id]);
}

// FQDN for a Coolify app: <app-name>.<customer-slug>.western-communication.com.
// Set at creation time because Coolify bakes the FQDN into the on-disk
// docker-compose.yaml on first deploy and changing it later doesn't
// reliably propagate (Coolify preserves the cached compose). The
// wildcard ingress on the customer tunnel + Caddy block + Cloudflare
// Total TLS handle the cert + routing layer.
const ROOT_DOMAIN = process.env.ROOT_DOMAIN || "western-communication.com";
function fqdnForApp(slug, app_name) {
  return `http://${app_name}.${slug}.${ROOT_DOMAIN}`;
}

async function createCoolifyApp(cf, app, slug) {
  const projects = await cf.get("/projects");
  if (!Array.isArray(projects) || projects.length === 0) {
    throw Object.assign(new Error("no project in Coolify; service-account bootstrap incomplete"), { status: 500 });
  }
  const project_uuid = projects[0].uuid;

  const servers = await cf.get("/servers");
  if (!Array.isArray(servers) || servers.length === 0) {
    throw Object.assign(new Error("no server in Coolify; localhost server not registered"), { status: 500 });
  }
  const server_uuid = servers[0].uuid;

  const envs = await cf.get(`/projects/${project_uuid}/environments`);
  if (!Array.isArray(envs) || envs.length === 0) {
    throw Object.assign(new Error("no environment in default project"), { status: 500 });
  }
  const environment_name = envs[0].name;

  const domains = fqdnForApp(slug, app.name);

  if (app.source_type === "git") {
    return cf.post("/applications/public", {
      project_uuid,
      server_uuid,
      environment_name,
      git_repository: app.source_repo,
      git_branch:     app.source_branch,
      build_pack:     app.build_pack || "nixpacks",
      name:           app.name,
      ports_exposes:  "3000",
      domains,
      instant_deploy: false,
    });
  }
  if (app.source_type === "dockerimage") {
    return cf.post("/applications/dockerimage", {
      project_uuid,
      server_uuid,
      environment_name,
      docker_registry_image_name: app.docker_image,
      name:                       app.name,
      ports_exposes:              "3000",
      domains,
      instant_deploy:             false,
    });
  }
  if (app.source_type === "dockerfile") {
    return cf.post("/applications/dockerfile", {
      project_uuid,
      server_uuid,
      environment_name,
      git_repository: app.source_repo,
      git_branch:     app.source_branch,
      name:           app.name,
      ports_exposes:  "3000",
      domains,
      instant_deploy: false,
    });
  }
  throw new Error(`unknown source_type ${app.source_type}`);
}

async function list(req, res, { slug }) {
  const apps = await db.rowsJson(`
    SELECT row_to_json(t) FROM (
      SELECT * FROM apps WHERE customer_slug = $1 ORDER BY created_at DESC
    ) t
  `, [slug]);
  json(res, 200, apps);
}

async function create(req, res, { slug, body }) {
  if (!body.name || !NAME_RE.test(body.name)) return bad(res, 400, "invalid name", "invalid_name");
  if (!["git","dockerfile","dockerimage"].includes(body.source_type)) return bad(res, 400, "invalid source_type", "invalid_source_type");
  if ((body.source_type === "git" || body.source_type === "dockerfile") && !body.source_repo) return bad(res, 400, "source_repo required", "missing_repo");
  if (body.source_type === "dockerimage" && !body.docker_image) return bad(res, 400, "docker_image required", "missing_image");

  const inserted = await db.oneJson(`
    WITH ins AS (
      INSERT INTO apps (customer_slug, name, source_type, source_repo, source_branch, docker_image, build_pack, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
      RETURNING *
    )
    SELECT row_to_json(t) FROM ins t
  `, [slug, body.name, body.source_type, body.source_repo ?? null, body.source_branch ?? "main",
      body.docker_image ?? null, body.build_pack ?? "nixpacks"]);

  let cfApp = null;
  let cfErr = null;
  try {
    const cf = await coolify.forSlug(slug);
    cfApp = await createCoolifyApp(cf, inserted, slug);
  } catch (e) {
    cfErr = e;
  }

  if (cfApp && cfApp.uuid) {
    const updated = await db.oneJson(`
      WITH upd AS (
        UPDATE apps SET coolify_app_uuid = $2, status = 'stopped', updated_at = now()
          WHERE id = $1 RETURNING *
      )
      SELECT row_to_json(t) FROM upd t
    `, [inserted.id, cfApp.uuid]);
    return json(res, 201, updated);
  }

  // Coolify side incomplete. Keep the DB row, mark it failed so it's
  // not orphaned-looking, and return 201 with the row + a warning so
  // the console can retry without seeing a hard error.
  await db.exec(`UPDATE apps SET status = 'failed', updated_at = now() WHERE id = $1`, [inserted.id]);
  console.error("[apps.create] coolify setup did not complete:", cfErr && cfErr.message);
  const current = await db.oneJson(
    `SELECT row_to_json(t) FROM (SELECT * FROM apps WHERE id = $1) t`,
    [inserted.id],
  );
  return json(res, 201, {
    ...current,
    warning: {
      code: (cfErr && cfErr.code) || "coolify_setup_incomplete",
      message: (cfErr && cfErr.message) || "Coolify did not return an application UUID",
    },
  });
}

async function get(req, res, { slug, params }) {
  const app = await appBySlugAndId(slug, params.id);
  if (!app) return bad(res, 404, "not found", "not_found");
  json(res, 200, app);
}

async function patch(req, res, { slug, params, body }) {
  const app = await appBySlugAndId(slug, params.id);
  if (!app) return bad(res, 404, "not found", "not_found");

  const sets = [];
  const vals = [];
  let i = 1;
  for (const k of ["name","source_repo","source_branch","docker_image","build_pack"]) {
    if (k in body) { sets.push(`${k} = $${++i}`); vals.push(body[k]); }
  }
  if (sets.length === 0) return json(res, 200, app);
  const sql = `
    WITH upd AS (
      UPDATE apps SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 RETURNING *
    )
    SELECT row_to_json(t) FROM upd t`;
  const updated = await db.oneJson(sql, [app.id, ...vals]);

  if (app.coolify_app_uuid) {
    const cf = await coolify.forSlug(slug);
    const cfBody = {};
    if (body.name)          cfBody.name = body.name;
    if (body.source_repo)   cfBody.git_repository = body.source_repo;
    if (body.source_branch) cfBody.git_branch = body.source_branch;
    if (body.build_pack)    cfBody.build_pack = body.build_pack;
    if (Object.keys(cfBody).length) await cf.patch(`/applications/${app.coolify_app_uuid}`, cfBody);
  }
  json(res, 200, updated);
}

async function del(req, res, { slug, params }) {
  const app = await appBySlugAndId(slug, params.id);
  if (!app) return bad(res, 404, "not found", "not_found");
  if (app.coolify_app_uuid) {
    try {
      const cf = await coolify.forSlug(slug);
      await cf.delete(`/applications/${app.coolify_app_uuid}`);
    } catch (e) { /* allow DB-side delete even if Coolify is gone */ }
  }
  await db.exec(`DELETE FROM apps WHERE id = $1`, [app.id]);
  json(res, 200, { ok: true });
}

async function deploy(req, res, { slug, params, body }) {
  const app = await appBySlugAndId(slug, params.id);
  if (!app || !app.coolify_app_uuid) return bad(res, 404, "not found", "not_found");
  const cf = await coolify.forSlug(slug);
  const force = body.force ? "?force_rebuild=true" : "";
  const deployment = await cf.post(`/applications/${app.coolify_app_uuid}/start${force}`, {});
  await db.exec(`UPDATE apps SET status = 'building', last_deploy_at = now(), updated_at = now() WHERE id = $1`, [app.id]);
  json(res, 200, {
    deployment_uuid: deployment.deployment_uuid || deployment.uuid,
    status: "queued",
    started_at: new Date().toISOString(),
    finished_at: null,
  });
}

async function deployments(req, res, { slug, params }) {
  const app = await appBySlugAndId(slug, params.id);
  if (!app || !app.coolify_app_uuid) return bad(res, 404, "not found", "not_found");
  const cf = await coolify.forSlug(slug);
  const list = await cf.get(`/deployments/applications/${app.coolify_app_uuid}`);
  json(res, 200, list);
}

async function logs(req, res, { slug, params, query }) {
  const app = await appBySlugAndId(slug, params.id);
  if (!app || !app.coolify_app_uuid) return bad(res, 404, "not found", "not_found");
  const tail = Math.min(parseInt(query.tail || "200", 10) || 200, 5000);
  // Coolify can 500 on this endpoint when the app has never started or
  // the container is gone. Treat that as 'no logs yet' instead of
  // bubbling up — frontend pages depend on this loading cleanly.
  try {
    const cf = await coolify.forSlug(slug);
    const out = await cf.get(`/applications/${app.coolify_app_uuid}/logs?lines=${tail}`);
    const text = (out && (out.logs || out.output || out)) || "";
    return json(res, 200, { lines: String(text).split(/\r?\n/), available: true });
  } catch (e) {
    return json(res, 200, { lines: [], available: false, reason: e.message || "runtime logs unavailable" });
  }
}

async function envGet(req, res, { slug, params }) {
  const app = await appBySlugAndId(slug, params.id);
  if (!app) return bad(res, 404, "not found", "not_found");
  const vars = await db.rowsJson(`
    SELECT row_to_json(t) FROM (
      SELECT key, value, is_build_time, is_preview FROM app_env_vars WHERE app_id = $1 ORDER BY key
    ) t
  `, [app.id]);
  json(res, 200, vars);
}

async function envPut(req, res, { slug, params, body }) {
  const app = await appBySlugAndId(slug, params.id);
  if (!app) return bad(res, 404, "not found", "not_found");
  if (!Array.isArray(body)) return bad(res, 400, "expected array of env vars", "invalid_body");

  await db.exec(`DELETE FROM app_env_vars WHERE app_id = $1`, [app.id]);
  await db.exec(
    `INSERT INTO audit_log (actor, action, slug, details) VALUES ($1, $2, $3, $4)`,
    [(req.headers["x-wcn-actor"] || "system").toString().slice(0, 120),
     "app.env.put", slug, `app=${app.id} keys=${body.map(v => v.key).filter(Boolean).join(",")}`],
  );
  for (const v of body) {
    if (!v.key || typeof v.key !== "string") continue;
    await db.exec(`
      INSERT INTO app_env_vars (app_id, key, value, is_build_time, is_preview)
      VALUES ($1, $2, $3, $4, $5)
    `, [app.id, v.key, String(v.value ?? ""), !!v.is_build_time, !!v.is_preview]);
  }

  if (app.coolify_app_uuid) {
    const cf = await coolify.forSlug(slug);
    const bulk = body.map((v) => ({
      key: v.key, value: String(v.value ?? ""),
      is_build_time: !!v.is_build_time, is_preview: !!v.is_preview,
    }));
    await cf.patch(`/applications/${app.coolify_app_uuid}/envs/bulk`, { data: bulk });
  }

  const out = await db.rowsJson(`
    SELECT row_to_json(t) FROM (
      SELECT key, value, is_build_time, is_preview FROM app_env_vars WHERE app_id = $1 ORDER BY key
    ) t
  `, [app.id]);
  json(res, 200, out);
}


async function lifecycleAction(action, statusAfter, req, res, { slug, params }) {
  const app = await appBySlugAndId(slug, params.id);
  if (!app || !app.coolify_app_uuid) return bad(res, 404, "not found", "not_found");
  const cf = await coolify.forSlug(slug);
  await cf.post(`/applications/${app.coolify_app_uuid}/${action}`, {});
  await db.exec(`UPDATE apps SET status = $2, updated_at = now() WHERE id = $1`, [app.id, statusAfter]);
  json(res, 200, { ok: true, action, status: statusAfter });
}

async function restart(req, res, ctx) { return lifecycleAction("restart", "running", req, res, ctx); }
async function stop(req, res, ctx)    { return lifecycleAction("stop",    "stopped", req, res, ctx); }
async function start(req, res, ctx)   { return lifecycleAction("start",   "running", req, res, ctx); }

async function rollback(req, res, { slug, params, body }) {
  const app = await appBySlugAndId(slug, params.id);
  if (!app || !app.coolify_app_uuid) return bad(res, 404, "not found", "not_found");
  if (!body.deployment_uuid) return bad(res, 400, "deployment_uuid required", "missing_deployment");
  const cf = await coolify.forSlug(slug);
  // Coolify v1 redeploy: POST /deployments/{deployment_uuid}/redeploy
  const out = await cf.post(`/deployments/${body.deployment_uuid}/redeploy`, {});
  await db.exec(`UPDATE apps SET status = 'building', last_deploy_at = now(), updated_at = now() WHERE id = $1`, [app.id]);
  json(res, 200, {
    deployment_uuid: out.deployment_uuid || out.uuid || body.deployment_uuid,
    status: "queued",
    started_at: new Date().toISOString(),
    finished_at: null,
  });
}


function sseHeaders(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "connection": "keep-alive",
    "x-accel-buffering": "no",
  });
}

function sseSend(res, event, data) {
  res.write(`event: ${event}\ndata: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
}

async function streamDeployLog(req, res, { slug, params }) {
  const app = await appBySlugAndId(slug, params.id);
  if (!app || !app.coolify_app_uuid) return bad(res, 404, "not found", "not_found");
  const cf = await coolify.forSlug(slug);
  sseHeaders(res);
  let closed = false;
  let sentLen = 0;
  req.on("close", () => { closed = true; });
  const hb = setInterval(() => { if (!closed) res.write(": ping\n\n"); }, 15000);
  try {
    while (!closed) {
      let dep;
      try {
        dep = await cf.get(`/deployments/${params.deployment_id}`);
      } catch (e) {
        sseSend(res, "error", { message: e.message });
        break;
      }
      const logs = (dep && (dep.logs || dep.output)) || "";
      if (logs.length > sentLen) {
        const chunk = logs.slice(sentLen);
        for (const line of chunk.split(/\r?\n/)) {
          if (line) sseSend(res, "log", line);
        }
        sentLen = logs.length;
      }
      const st = dep && dep.status;
      if (["finished", "failed", "error", "cancelled"].includes(st)) {
        sseSend(res, "done", { status: st });
        break;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  } finally {
    clearInterval(hb);
    if (!closed) res.end();
  }
}

async function streamRuntimeLogs(req, res, { slug, params, query }) {
  const app = await appBySlugAndId(slug, params.id);
  if (!app || !app.coolify_app_uuid) return bad(res, 404, "not found", "not_found");
  const vm = await db.oneJson(
    `SELECT row_to_json(t) FROM (SELECT ip FROM vms WHERE customer_slug = $1) t`,
    [slug],
  );
  if (!vm) return bad(res, 404, "vm not found", "not_found");

  const containerName = await resolveContainerName(vm.ip, app.coolify_app_uuid);
  if (!containerName) {
    return bad(res, 503, "container not running yet", "container_not_found");
  }

  sseHeaders(res);
  const tail = Math.min(parseInt(query.tail || "200", 10) || 200, 5000);
  const proc = spawn(
    "ssh",
    [
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", "ConnectTimeout=10",
      `ops@${vm.ip}`,
      "docker", "logs", "--tail", String(tail), "--follow", containerName,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  let closed = false;
  req.on("close", () => {
    closed = true;
    try { proc.kill("SIGTERM"); } catch {}
  });
  const hb = setInterval(() => { if (!closed) res.write(": ping\n\n"); }, 15000);

  function pipeStream(stream) {
    let buf = "";
    stream.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const line of lines) {
        if (line && !closed) sseSend(res, "log", line);
      }
    });
  }
  pipeStream(proc.stdout);
  pipeStream(proc.stderr);

  proc.on("close", (code) => {
    clearInterval(hb);
    if (!closed) {
      sseSend(res, "done", { exit: code });
      res.end();
    }
  });
}


// ── Scheduled tasks (per-app cron) — Coolify v1 passthrough ─────────
async function cronList(req, res, { slug, params }) {
  const app = await appBySlugAndId(slug, params.id);
  if (!app || !app.coolify_app_uuid) return bad(res, 404, "not found", "not_found");
  const cf = await coolify.forSlug(slug);
  const list = await cf.get(`/applications/${app.coolify_app_uuid}/scheduled-tasks`);
  json(res, 200, list || []);
}

async function cronCreate(req, res, { slug, params, body }) {
  const app = await appBySlugAndId(slug, params.id);
  if (!app || !app.coolify_app_uuid) return bad(res, 404, "not found", "not_found");
  if (!body.name || !body.command || !body.frequency) {
    return bad(res, 400, "name, command, frequency required", "missing_fields");
  }
  const cf = await coolify.forSlug(slug);
  const created = await cf.post(`/applications/${app.coolify_app_uuid}/scheduled-tasks`, {
    name: body.name,
    command: body.command,
    frequency: body.frequency,
    container: body.container || null,
  });
  json(res, 201, created);
}

async function cronDelete(req, res, { slug, params }) {
  const app = await appBySlugAndId(slug, params.id);
  if (!app || !app.coolify_app_uuid) return bad(res, 404, "not found", "not_found");
  const cf = await coolify.forSlug(slug);
  await cf.delete(`/applications/${app.coolify_app_uuid}/scheduled-tasks/${params.task_uuid}`);
  json(res, 200, { ok: true });
}

// ── One-off exec — SSE of stdout/stderr from `docker exec` ──────────
async function execCommand(req, res, { slug, params, body }) {
  const app = await appBySlugAndId(slug, params.id);
  if (!app || !app.coolify_app_uuid) return bad(res, 404, "not found", "not_found");
  if (app.status === "building") return bad(res, 409, "app is currently building", "app_building");
  if (!body.command || typeof body.command !== "string") {
    return bad(res, 400, "command (string) required", "missing_command");
  }
  if (body.command.length > 4000) return bad(res, 400, "command too long", "command_too_long");

  const timeoutSec = Math.min(parseInt(body.timeout_seconds || "60", 10) || 60, 600);

  const vm = await db.oneJson(
    `SELECT row_to_json(t) FROM (SELECT ip FROM vms WHERE customer_slug = $1) t`,
    [slug],
  );
  if (!vm) return bad(res, 404, "vm not found", "not_found");

  const containerName = await resolveContainerName(vm.ip, app.coolify_app_uuid);
  if (!containerName) {
    return bad(res, 503, "container not running", "container_not_found");
  }

  // Audit
  try {
    await db.exec(
      `INSERT INTO audit_log (actor, action, slug, details) VALUES ($1, $2, $3, $4)`,
      [
        (req.headers["x-wcn-actor"] || "system").toString().slice(0, 120),
        "app.exec",
        slug,
        `app=${app.id} container=${containerName} cmd=${body.command.slice(0, 500)}`,
      ],
    );
  } catch (e) {
    console.error("[apps.exec] audit insert failed:", e.message);
  }

  sseHeaders(res);
  sseSend(res, "meta", { container: containerName, timeout_seconds: timeoutSec });

  const proc = spawn(
    "ssh",
    [
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", "ConnectTimeout=10",
      `ops@${vm.ip}`,
      "timeout", String(timeoutSec),
      "docker", "exec", containerName,
      "sh", "-c", body.command,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  let closed = false;
  req.on("close", () => {
    closed = true;
    try { proc.kill("SIGTERM"); } catch {}
  });
  const hb = setInterval(() => { if (!closed) res.write(": ping\n\n"); }, 15000);

  function pipeStream(stream, channel) {
    let buf = "";
    stream.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const line of lines) {
        if (line && !closed) sseSend(res, channel, line);
      }
    });
    stream.on("end", () => {
      if (buf && !closed) sseSend(res, channel, buf);
    });
  }
  pipeStream(proc.stdout, "stdout");
  pipeStream(proc.stderr, "stderr");

  proc.on("close", (code) => {
    clearInterval(hb);
    if (!closed) {
      sseSend(res, "done", { exit: code });
      res.end();
    }
  });
}


// Parse a .env-style text body and replace all env vars. Each non-blank
// non-comment line must be KEY=VALUE. Trailing whitespace is stripped.
// Quotes (' or ") around value are stripped if balanced.
async function envImport(req, res, { slug, params, body }) {
  const app = await appBySlugAndId(slug, params.id);
  if (!app) return bad(res, 404, "not found", "not_found");
  if (!body || typeof body.text !== "string") return bad(res, 400, "text required", "missing_text");
  if (body.text.length > 200000) return bad(res, 400, "too large (max 200KB)", "too_large");

  const items = [];
  const errors = [];
  let lineNo = 0;
  for (const raw of body.text.split(/\r?\n/)) {
    lineNo++;
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) { errors.push({ line: lineNo, reason: "missing '='" }); continue; }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      errors.push({ line: lineNo, key, reason: "invalid key (must match [A-Za-z_][A-Za-z0-9_]*)" });
      continue;
    }
    items.push({ key, value, is_build_time: !!body.is_build_time, is_preview: !!body.is_preview });
  }
  if (errors.length > 0 && !body.ignore_errors) {
    return bad(res, 400, `invalid input — ${errors.length} error(s)`, "parse_errors");
  }

  await db.exec(`DELETE FROM app_env_vars WHERE app_id = $1`, [app.id]);
  await db.exec(
    `INSERT INTO audit_log (actor, action, slug, details) VALUES ($1, $2, $3, $4)`,
    [(req.headers["x-wcn-actor"] || "system").toString().slice(0, 120),
     "app.env.import", slug, `app=${app.id} count=${items.length}`],
  );
  for (const v of items) {
    await db.exec(
      `INSERT INTO app_env_vars (app_id, key, value, is_build_time, is_preview)
       VALUES ($1, $2, $3, $4, $5)`,
      [app.id, v.key, v.value, v.is_build_time, v.is_preview],
    );
  }

  if (app.coolify_app_uuid) {
    const cf = await coolify.forSlug(slug);
    await cf.patch(`/applications/${app.coolify_app_uuid}/envs/bulk`, { data: items });
  }

  json(res, 200, { imported: items.length, errors });
}

async function domainsList(req, res, { slug, params }) {
  const app = await appBySlugAndId(slug, params.id);
  if (!app) return bad(res, 404, "not found", "not_found");
  const list = await db.rowsJson(`
    SELECT row_to_json(t) FROM (
      SELECT hostname, status, cf_custom_hostname_id, activated_at FROM domains
      WHERE app_id = $1 AND status != 'deleted' ORDER BY hostname
    ) t
  `, [app.id]);
  json(res, 200, list);
}
async function domainAdd(req, res, ctx)    { return domains.add(req, res, ctx); }
async function domainStatus(req, res, ctx) { return domains.status(req, res, ctx); }
async function domainDelete(req, res, ctx) { return domains.delete(req, res, ctx); }

module.exports = {
  list, create, get, patch, delete: del,
  deploy, deployments, logs,
  restart, stop, start, rollback, streamDeployLog, streamRuntimeLogs,
  cronList, cronCreate, cronDelete, execCommand,
  envGet, envPut, envImport,
  domainsList, domainAdd, domainStatus, domainDelete,
};
