// Vercel DNS client. Vercel exposes DNS at the Domains v4 API.
// API: https://vercel.com/docs/rest-api/reference/endpoints/domains

const BASE = "https://api.vercel.com";

function create(credentials) {
  const token = String(credentials.api_token || "").trim();
  const teamId = String(credentials.team_id || "").trim() || null;
  if (!token) throw new Error("vercel: api_token required");

  function withTeam(path) {
    if (!teamId) return path;
    return path + (path.includes("?") ? "&" : "?") + `teamId=${encodeURIComponent(teamId)}`;
  }

  async function call(method, path, body) {
    const res = await fetch(`${BASE}${withTeam(path)}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = method === "DELETE" && res.status === 200 ? {} : await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (data.error && (data.error.message || data.error.code)) || `vercel ${res.status}`;
      const err = new Error(msg);
      err.upstream_status = res.status;
      throw err;
    }
    return data;
  }

  return {
    provider: "vercel",

    async test() {
      try {
        await call("GET", "/v5/domains?limit=1");
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    async listZones() {
      const out = [];
      let next = null;
      while (true) {
        const q = `?limit=100${next ? `&until=${encodeURIComponent(next)}` : ""}`;
        const data = await call("GET", `/v5/domains${q}`);
        for (const d of data.domains || []) {
          out.push({
            id: d.name,
            name: d.name,
            capabilities: { alias: true, cname_flattening: false },
          });
        }
        if (!data.pagination || !data.pagination.next) break;
        next = data.pagination.next;
      }
      return out;
    },

    async findRecord(zoneId, name, type) {
      // Vercel DNS records: /v4/domains/{domain}/records
      const data = await call("GET", `/v4/domains/${encodeURIComponent(zoneId)}/records?limit=100`);
      const sub = name === zoneId ? "@" : name.replace(`.${zoneId}`, "");
      const r = (data.records || []).find((x) => x.type === type && (x.name === sub || x.name === name));
      if (!r) return null;
      return {
        id: r.id,
        name: r.name === "@" ? zoneId : `${r.name}.${zoneId}`,
        type: r.type,
        content: r.value,
        ttl: r.ttl,
      };
    },

    async upsertRecord(zoneId, record) {
      // Vercel doesn't have a true upsert — find + delete + recreate.
      const existing = await this.findRecord(zoneId, record.name, record.type);
      if (existing) {
        await this.deleteRecord(zoneId, existing.id);
      }
      const sub = record.name === zoneId ? "@" : record.name.replace(`.${zoneId}`, "");
      const data = await call("POST", `/v2/domains/${encodeURIComponent(zoneId)}/records`, {
        name: sub,
        type: record.type,
        value: record.content,
        ttl: record.ttl && record.ttl > 1 ? record.ttl : 300,
        comment: "Managed by WCN Cloud",
      });
      return {
        id: data.uid || data.id,
        name: record.name,
        type: record.type,
        content: record.content,
        ttl: record.ttl || 300,
      };
    },

    async deleteRecord(zoneId, recordId) {
      try {
        await call("DELETE", `/v2/domains/${encodeURIComponent(zoneId)}/records/${recordId}`);
      } catch (e) {
        if (e.upstream_status === 404) return;
        throw e;
      }
    },
  };
}

module.exports = { create };
