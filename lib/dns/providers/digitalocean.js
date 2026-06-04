// DigitalOcean DNS client. https://docs.digitalocean.com/reference/api/api-reference/#tag/Domains

const BASE = "https://api.digitalocean.com/v2";

function create(credentials) {
  const token = String(credentials.api_token || "").trim();
  if (!token) throw new Error("digitalocean: api_token required");

  async function call(method, path, body) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data.message || `digitalocean ${res.status}`;
      const err = new Error(msg);
      err.upstream_status = res.status;
      throw err;
    }
    return data;
  }

  return {
    provider: "digitalocean",

    async test() {
      try {
        await call("GET", "/domains?per_page=1");
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    async listZones() {
      const out = [];
      let page = 1;
      while (true) {
        const data = await call("GET", `/domains?per_page=200&page=${page}`);
        for (const d of data.domains || []) {
          out.push({
            id: d.name,
            name: d.name,
            capabilities: { alias: false, cname_flattening: false },
          });
        }
        if (!data.links || !data.links.pages || !data.links.pages.next) break;
        page += 1;
      }
      return out;
    },

    async findRecord(zoneId, name, type) {
      // DO's "name" field is the sub-part (no zone) — "www" not "www.example.com".
      const sub = name === zoneId ? "@" : name.replace(`.${zoneId}`, "");
      const data = await call(
        "GET",
        `/domains/${encodeURIComponent(zoneId)}/records?type=${type}&name=${encodeURIComponent(sub === "@" ? zoneId : sub + "." + zoneId)}&per_page=20`,
      );
      const r = (data.domain_records || []).find((x) => x.type === type && (x.name === sub || x.name === name));
      if (!r) return null;
      return {
        id: String(r.id),
        name: r.name === "@" ? zoneId : `${r.name}.${zoneId}`,
        type: r.type,
        content: r.data,
        ttl: r.ttl,
      };
    },

    async upsertRecord(zoneId, record) {
      const sub = record.name === zoneId ? "@" : record.name.replace(`.${zoneId}`, "");
      const ttl = record.ttl && record.ttl > 30 ? record.ttl : 1800; // DO min is 30
      const data = record.type === "CNAME" && !record.content.endsWith(".") ? record.content + "." : record.content;

      const existing = await this.findRecord(zoneId, record.name, record.type);
      if (existing) {
        const res = await call("PUT", `/domains/${encodeURIComponent(zoneId)}/records/${existing.id}`, {
          name: sub,
          type: record.type,
          data,
          ttl,
        });
        return {
          id: String(res.domain_record.id),
          name: record.name,
          type: record.type,
          content: data,
          ttl,
        };
      }
      const res = await call("POST", `/domains/${encodeURIComponent(zoneId)}/records`, {
        name: sub,
        type: record.type,
        data,
        ttl,
      });
      return {
        id: String(res.domain_record.id),
        name: record.name,
        type: record.type,
        content: data,
        ttl,
      };
    },

    async deleteRecord(zoneId, recordId) {
      try {
        await call("DELETE", `/domains/${encodeURIComponent(zoneId)}/records/${recordId}`);
      } catch (e) {
        if (e.upstream_status === 404) return;
        throw e;
      }
    },
  };
}

module.exports = { create };
