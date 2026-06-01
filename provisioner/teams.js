// T3 #25 — Customer team / RBAC data plane. Provisioner just stores
// team rows and generates invite tokens; console enforces roles.

const crypto = require("crypto");
const db = require("./db");

const ROLES = ["owner", "admin", "developer", "viewer"];
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
function bad(res, code, err, error_code = "bad_request") {
  json(res, code, { error: err, code: error_code });
}

async function audit(req, action, slug, details = "") {
  try {
    await db.exec(
      `INSERT INTO audit_log (actor, action, slug, details) VALUES ($1, $2, $3, $4)`,
      [(req.headers["x-wcn-actor"] || "system").toString().slice(0, 120), action, slug, details],
    );
  } catch (e) { console.error("[teams] audit failed:", e.message); }
}

// GET /customers/{slug}/team
async function list(req, res, { slug }) {
  const rows = await db.rowsJson(
    `SELECT row_to_json(t) FROM (
       SELECT id, user_email, role, invited_by, invited_at, accepted_at, revoked_at,
              invite_token IS NOT NULL AND accepted_at IS NULL AND revoked_at IS NULL AS pending_invite
       FROM customer_users WHERE customer_slug = $1 ORDER BY invited_at DESC
     ) t`,
    [slug],
  );
  json(res, 200, rows);
}

// POST /customers/{slug}/team/invites { email, role }
// Generates an invite_token the console uses to construct the magic link.
async function invite(req, res, { slug, body }) {
  const email = String(body.email || "").toLowerCase().trim();
  const role = String(body.role || "viewer").toLowerCase();
  if (!EMAIL_RE.test(email)) return bad(res, 400, "invalid email", "invalid_email");
  if (!ROLES.includes(role)) return bad(res, 400, `role must be one of: ${ROLES.join(", ")}`, "invalid_role");

  const inviter = (req.headers["x-wcn-actor"] || "system").toString().slice(0, 120);

  const existing = await db.oneJson(
    `SELECT row_to_json(t) FROM (
       SELECT id, accepted_at, revoked_at FROM customer_users WHERE customer_slug = $1 AND user_email = $2
     ) t`,
    [slug, email],
  );
  if (existing && existing.accepted_at && !existing.revoked_at) {
    return bad(res, 409, "user already a member", "already_member");
  }

  const token = crypto.randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

  const row = await db.oneJson(
    `WITH up AS (
       INSERT INTO customer_users (customer_slug, user_email, role, invited_by, invite_token, invite_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (customer_slug, user_email) DO UPDATE
         SET role = EXCLUDED.role,
             invited_by = EXCLUDED.invited_by,
             invite_token = EXCLUDED.invite_token,
             invite_expires_at = EXCLUDED.invite_expires_at,
             invited_at = now(),
             accepted_at = NULL,
             revoked_at = NULL
         RETURNING *
     )
     SELECT row_to_json(t) FROM up t`,
    [slug, email, role, inviter, token, expiresAt],
  );
  await audit(req, "team.invite", slug, `email=${email} role=${role}`);
  json(res, 201, {
    id: row.id,
    user_email: row.user_email,
    role: row.role,
    invite_token: token,
    invite_expires_at: expiresAt,
  });
}

// POST /team/invites/accept { token, accepting_email }
// Console uses this once the invitee clicks the magic link and signs
// in via SSO. The accepting_email must match the invite's email.
async function accept(req, res, { body }) {
  const token = body && body.token;
  const acceptingEmail = String(body && body.accepting_email || "").toLowerCase().trim();
  if (!token) return bad(res, 400, "token required", "missing_token");
  if (!EMAIL_RE.test(acceptingEmail)) return bad(res, 400, "invalid accepting_email", "invalid_email");

  const row = await db.oneJson(
    `SELECT row_to_json(t) FROM (
       SELECT id, customer_slug, user_email, role, invite_expires_at, accepted_at, revoked_at
       FROM customer_users WHERE invite_token = $1
     ) t`,
    [token],
  );
  if (!row) return bad(res, 404, "invite not found", "not_found");
  if (row.revoked_at) return bad(res, 410, "invite revoked", "invite_revoked");
  if (row.accepted_at) return bad(res, 409, "invite already accepted", "already_accepted");
  if (new Date(row.invite_expires_at).getTime() < Date.now()) {
    return bad(res, 410, "invite expired", "invite_expired");
  }
  if (row.user_email.toLowerCase() !== acceptingEmail) {
    return bad(res, 403, "accepting email does not match invite", "email_mismatch");
  }

  await db.exec(
    `UPDATE customer_users SET accepted_at = now(), invite_token = NULL, invite_expires_at = NULL
     WHERE id = $1`,
    [row.id],
  );
  await audit(req, "team.accept", row.customer_slug, `email=${row.user_email} role=${row.role}`);
  json(res, 200, { customer_slug: row.customer_slug, user_email: row.user_email, role: row.role });
}

// PATCH /customers/{slug}/team/{id} { role }
async function update(req, res, { slug, params, body }) {
  const id = parseInt(params.id, 10);
  if (!Number.isInteger(id) || id < 1) return bad(res, 400, "invalid id", "invalid_id");
  const role = String(body.role || "").toLowerCase();
  if (!ROLES.includes(role)) return bad(res, 400, `role must be one of: ${ROLES.join(", ")}`, "invalid_role");

  const row = await db.oneJson(
    `SELECT row_to_json(t) FROM (
       SELECT customer_slug, user_email FROM customer_users WHERE id = $1 AND customer_slug = $2
     ) t`,
    [id, slug],
  );
  if (!row) return bad(res, 404, "member not found", "not_found");

  await db.exec(`UPDATE customer_users SET role = $2 WHERE id = $1`, [id, role]);
  await audit(req, "team.role-change", slug, `email=${row.user_email} → ${role}`);
  json(res, 200, { ok: true });
}

// DELETE /customers/{slug}/team/{id}
async function revoke(req, res, { slug, params }) {
  const id = parseInt(params.id, 10);
  if (!Number.isInteger(id) || id < 1) return bad(res, 400, "invalid id", "invalid_id");
  const row = await db.oneJson(
    `SELECT row_to_json(t) FROM (
       SELECT customer_slug, user_email, role FROM customer_users WHERE id = $1 AND customer_slug = $2
     ) t`,
    [id, slug],
  );
  if (!row) return bad(res, 404, "member not found", "not_found");
  if (row.role === "owner") {
    const otherOwners = await db.oneJson(
      `SELECT row_to_json(t) FROM (
         SELECT COUNT(*)::int AS count FROM customer_users
         WHERE customer_slug = $1 AND role = 'owner' AND id <> $2 AND revoked_at IS NULL AND accepted_at IS NOT NULL
       ) t`,
      [slug, id],
    );
    if (!otherOwners || otherOwners.count === 0) {
      return bad(res, 409, "cannot revoke the last owner", "last_owner");
    }
  }
  await db.exec(`UPDATE customer_users SET revoked_at = now() WHERE id = $1`, [id]);
  await audit(req, "team.revoke", slug, `email=${row.user_email}`);
  json(res, 200, { ok: true });
}

// GET /customers/{slug}/team/by-email?email=...
// Used by the console session middleware to resolve role on login.
async function lookup(req, res, { slug, query }) {
  const email = String(query.email || "").toLowerCase().trim();
  if (!EMAIL_RE.test(email)) return bad(res, 400, "invalid email", "invalid_email");
  const row = await db.oneJson(
    `SELECT row_to_json(t) FROM (
       SELECT id, customer_slug, user_email, role, accepted_at, revoked_at
       FROM customer_users
       WHERE customer_slug = $1 AND user_email = $2 AND accepted_at IS NOT NULL AND revoked_at IS NULL
     ) t`,
    [slug, email],
  );
  if (!row) return json(res, 404, { error: "not a member", code: "not_member" });
  json(res, 200, row);
}

module.exports = { list, invite, accept, update, revoke, lookup, ROLES };
