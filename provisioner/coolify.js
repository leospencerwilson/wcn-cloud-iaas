// Per-customer-VM Coolify v1 API client. Uses fetch (Node 18+ builtin) and
// calls the customer VM directly over the LAN (not via cloudflared/Caddy,
// which would 401 us through wcn_auth).

const db = require("./db");

// Build a client bound to a specific customer's coolify_api_token + IP.
async function forSlug(slug) {
  const row = await db.oneJson(`
    SELECT row_to_json(t) FROM (
      SELECT host(v.ip) AS ip, v.coolify_api_token AS token
      FROM vms v
      WHERE v.customer_slug = $1
        AND v.status IN ('active','reserving')
    ) t
  `, [slug]);
  if (!row || !row.ip)    throw Object.assign(new Error("no VM"), { code: "no_vm",    status: 404 });
  if (!row.token)         throw Object.assign(new Error("no Coolify API token"), { code: "no_token", status: 503 });

  const base = `http://${row.ip}:8000/api/v1`;
  const headers = {
    "Authorization": `Bearer ${row.token}`,
    "Content-Type":  "application/json",
    "Accept":        "application/json",
  };

  async function call(method, path, body) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const json = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
    if (!res.ok) {
      const msg = (json && json.message) || text || `HTTP ${res.status}`;
      throw Object.assign(new Error(msg), { code: "coolify_error", status: res.status, body: json });
    }
    return json;
  }

  return {
    get:    (path)        => call("GET",    path),
    post:   (path, body)  => call("POST",   path, body),
    patch:  (path, body)  => call("PATCH",  path, body),
    delete: (path)        => call("DELETE", path),
  };
}

module.exports = { forSlug };
