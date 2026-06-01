// GET /customers/{slug}/audit?since=ISO&until=ISO&action=prefix&limit=N

const db = require("./db");

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
function bad(res, code, err, error_code = "bad_request") {
  json(res, code, { error: err, code: error_code });
}

async function list(req, res, { slug, query }) {
  const filters = ["slug = $1"];
  const params = [slug];
  let i = 1;

  if (query.since) {
    const d = new Date(query.since);
    if (Number.isNaN(d.getTime())) return bad(res, 400, "invalid since", "invalid_since");
    filters.push(`ts >= $${++i}`); params.push(d.toISOString());
  }
  if (query.until) {
    const d = new Date(query.until);
    if (Number.isNaN(d.getTime())) return bad(res, 400, "invalid until", "invalid_until");
    filters.push(`ts <= $${++i}`); params.push(d.toISOString());
  }
  if (query.action) {
    if (!/^[a-zA-Z._-]{1,40}$/.test(query.action)) return bad(res, 400, "invalid action", "invalid_action");
    filters.push(`action LIKE $${++i}`); params.push(`${query.action}%`);
  }

  const limit = Math.min(parseInt(query.limit || "200", 10) || 200, 1000);
  const rows = await db.rowsJson(
    `SELECT row_to_json(t) FROM (
       SELECT id, ts, actor, action, slug, details
       FROM audit_log WHERE ${filters.join(" AND ")}
       ORDER BY ts DESC LIMIT ${limit}
     ) t`,
    params,
  );
  json(res, 200, rows);
}

module.exports = { list };
