// Admin-side endpoints. Currently just impersonate audit logging.

const db = require("./db");

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
function bad(res, code, err, error_code = "bad_request") {
  json(res, code, { error: err, code: error_code });
}

// POST /admin/impersonate { customer_slug }
// Records an admin impersonation event. The actual session state
// lives in the console — this endpoint only audit-logs.
async function impersonate(req, res, { body }) {
  const slug = body && body.customer_slug;
  if (!slug || typeof slug !== "string") {
    return bad(res, 400, "customer_slug required", "missing_slug");
  }
  const exists = await db.oneJson(
    `SELECT row_to_json(t) FROM (SELECT slug FROM customers WHERE slug = $1) t`,
    [slug],
  );
  if (!exists) return bad(res, 404, "customer not found", "not_found");

  await db.exec(
    `INSERT INTO audit_log (actor, action, slug, details) VALUES ($1, $2, $3, $4)`,
    [
      (req.headers["x-wcn-actor"] || "system").toString().slice(0, 120),
      body.action === "stop" ? "admin.impersonate.stop" : "admin.impersonate.start",
      slug,
      body.note ? String(body.note).slice(0, 500) : "",
    ],
  );
  json(res, 200, { ok: true });
}

module.exports = { impersonate };
