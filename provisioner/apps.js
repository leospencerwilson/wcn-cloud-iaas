// HTTP handlers for /apps/* endpoints. Each handler receives (req, res, ctx)
// where ctx has { slug, params, body } already parsed by server.js.

const db = require("./db");
const coolify = require("./coolify");

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
function bad(res, code, err, error_code = "bad_request") {
  json(res, code, { error: err, code: error_code });
}

// ── helpers ─────────────────────────────────────────────────────────────

async function appBySlugAndId(slug, id) {
  const app = await db.oneJson(`
    SELECT row_to_json(t) FROM (
      SELECT a.* FROM apps a WHERE a.customer_slug = $1 AND a.id = $2
    ) t
  `, [slug, id]);
  return app;
}

// Helper that POSTs to Coolify's typed-application endpoint. Coolify v1 has
// distinct create endpoints per source_type (public-git / dockerfile / dockerimage).
async function createCoolifyApp(cf, app) {
  // First we need the customer's default project + environment. The bootstrap
  // step creates a "WCN Service" team + default project on first install.
  // We pick the first project/environment owned by the service team.
  const projects = await cf.get("/projects");
  if (!Array.isArray(projects) || projects.length === 0) {
    throw Object.assign(new Error("no project in Coolify; service-account bootstrap incomplete"), { status: 500 });
  }
  const project_uuid = projects[0].uuid;
  const envs = await cf.get(`/projects/${project_uuid}/environments`);
  if (!Array.isArray(envs) || envs.length === 0) {
    throw Object.assign(new Error("no environment in default project"), { status: 500 });
  }
  const environment_name = envs[0].name;

  // Server: pick the local server (Coolify's "localhost" / default).
  const servers = await cf.get("/teams/current");  // returns team, has servers
  // (Coolify exposes a server-listing too — adapt if API shape differs.)

  if (app.source_type === "git") {
    return cf.post("/applications/public", {
      project_uuid,
      environment_name,
      git_repository: app.source_repo,
      git_branch:     app.source_branch,
      build_pack:     app.build_pack || "nixpacks",
      name:           app.name,
      ports_exposes:  "3000",
      instant_deploy: false,
    });
  }
  if (app.source_type === "dockerimage") {
    return cf.post("/applications/dockerimage", {
      project_uuid,
      environment_name,
      docker_registry_image_name: app.docker_image,
      name:                       app.name,
      ports_exposes:              "3000",
      instant_deploy:             false,
    });
  }
  if (app.source_type === "dockerfile") {
    return cf.post("/applications/dockerfile", {
      project_uuid,
      environment_name,
      git_repository: app.source_repo,
      git_branch:     app.source_branch,
      name:           app.name,
      ports_exposes:  "3000",
      instant_deploy: false,
    });
  }
  throw new Error(`unknown source_type ${app.source_type}`);
}

// ── handlers ────────────────────────────────────────────────────────────

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

  // Insert WCN-side record first (status=pending). Use RETURNING to get the id.
  const inserted = await db.oneJson(`
    SELECT row_to_json(t) FROM (
      INSERT INTO apps (customer_slug, name, source_type, source_repo, source_branch, docker_image, build_pack, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
      RETURNING *
    ) t
  `, [slug, body.name, body.source_type, body.source_repo ?? null, body.source_branch ?? "main",
      body.docker_image ?? null, body.build_pack ?? "nixpacks"]);

  // Call Coolify to actually create the app.
  let cfApp;
  try {
    const cf = await coolify.forSlug(slug);
    cfApp = await createCoolifyApp(cf, inserted);
  } catch (e) {
    await db.exec(`UPDATE apps SET status = 'failed', updated_at = now() WHERE id = $1`, [inserted.id]);
    throw e;
  }

  const updated = await db.oneJson(`
    SELECT row_to_json(t) FROM (
      UPDATE apps SET coolify_app_uuid = $2, status = 'stopped', updated_at = now()
        WHERE id = $1 RETURNING *
    ) t
  `, [inserted.id, cfApp.uuid]);
  json(res, 201, updated);
}

async function get(req, res, { slug, params }) {
  const app = await appBySlugAndId(slug, params.id);
  if (!app) return bad(res, 404, "not found", "not_found");
  json(res, 200, app);
}

async function patch(req, res, { slug, params, body }) {
  const app = await appBySlugAndId(slug, params.id);
  if (!app) return bad(res, 404, "not found", "not_found");

  // Whitelist of mutable fields
  const sets = [];
  const vals = [];
  let i = 1;
  for (const k of ["name","source_repo","source_branch","docker_image","build_pack"]) {
    if (k in body) { sets.push(`${k} = $${++i}`); vals.push(body[k]); }
  }
  if (sets.length === 0) return json(res, 200, app);
  const sql = `
    SELECT row_to_json(t) FROM (
      UPDATE apps SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 RETURNING *
    ) t`;
  const updated = await db.oneJson(sql, [app.id, ...vals]);

  // Push name/repo/branch changes to Coolify too if the app exists there.
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
  const cf = await coolify.forSlug(slug);
  const tail = Math.min(parseInt(query.tail || "200", 10) || 200, 5000);
  const out = await cf.get(`/applications/${app.coolify_app_uuid}/logs?lines=${tail}`);
  // Coolify returns { logs: "…\n…" } or similar — normalize to {lines: string[]}.
  const text = (out && (out.logs || out.output || out)) || "";
  json(res, 200, { lines: String(text).split(/\r?\n/) });
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

  // Replace-all semantics: delete then re-insert. Wrap in a transaction (psql -1).
  // Easier here: just do two queries, accepting a tiny inconsistency window if
  // the process dies between them.
  await db.exec(`DELETE FROM app_env_vars WHERE app_id = $1`, [app.id]);
  for (const v of body) {
    if (!v.key || typeof v.key !== "string") continue;
    await db.exec(`
      INSERT INTO app_env_vars (app_id, key, value, is_build_time, is_preview)
      VALUES ($1, $2, $3, $4, $5)
    `, [app.id, v.key, String(v.value ?? ""), !!v.is_build_time, !!v.is_preview]);
  }

  // Push to Coolify via /envs/bulk
  if (app.coolify_app_uuid) {
    const cf = await coolify.forSlug(slug);
    const bulk = body.map((v) => ({
      key: v.key, value: String(v.value ?? ""),
      is_build_time: !!v.is_build_time, is_preview: !!v.is_preview,
    }));
    await cf.patch(`/applications/${app.coolify_app_uuid}/envs/bulk`, { data: bulk });
  }

  // Return canonical from DB
  const out = await db.rowsJson(`
    SELECT row_to_json(t) FROM (
      SELECT key, value, is_build_time, is_preview FROM app_env_vars WHERE app_id = $1 ORDER BY key
    ) t
  `, [app.id]);
  json(res, 200, out);
}

// — domain handlers are stubs; full impl lands in PR 3 after the
//   add-custom-domain.sh refactor.
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
async function domainAdd(req, res)    { bad(res, 501, "domain add: pending PR 3", "not_implemented"); }
async function domainStatus(req, res) { bad(res, 501, "domain status: pending PR 3", "not_implemented"); }
async function domainDelete(req, res) { bad(res, 501, "domain delete: pending PR 3", "not_implemented"); }

module.exports = {
  list, create, get, patch, delete: del,
  deploy, deployments, logs,
  envGet, envPut,
  domainsList, domainAdd, domainStatus, domainDelete,
};
