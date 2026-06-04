// Cloudflare DNS client. Uses the v4 REST API with an API token.
// API docs: https://developers.cloudflare.com/api/operations/dns-records-for-a-zone-list-dns-records
//
// We don't pull the full Node SDK — one fetch wrapper avoids any
// dependency surface for the provisioner.

const BASE = "https://api.cloudflare.com/client/v4";

function create(credentials) {
  const token = String(credentials.api_token || "").trim();
  if (!token) throw new Error("cloudflare: api_token required");

  async function call(method, path, body) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) {
      const msg =
        (data.errors && data.errors[0] && data.errors[0].message) ||
        data.message ||
        `cloudflare ${res.status}`;
      const err = new Error(msg);
      err.code = (data.errors && data.errors[0] && data.errors[0].code) || res.status;
      err.upstream_status = res.status;
      throw err;
    }
    return data;
  }

  return {
    provider: "cloudflare",

    async test() {
      try {
        // Cheap call that exercises the token — verifies it's live + readable.
        await call("GET", "/user/tokens/verify");
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    async listZones() {
      // Paginate just in case (zone counts >50 happen).
      const out = [];
      let page = 1;
      while (true) {
        const res = await call("GET", `/zones?per_page=50&page=${page}`);
        for (const z of res.result || []) {
          out.push({
            id: z.id,
            name: z.name,
            capabilities: { alias: false, cname_flattening: true },
          });
        }
        if (!res.result_info || page * res.result_info.per_page >= res.result_info.total_count) break;
        page += 1;
      }
      return out;
    },

    async findRecord(zoneId, name, type) {
      const res = await call(
        "GET",
        `/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}&type=${type}`,
      );
      const r = (res.result || [])[0];
      if (!r) return null;
      return {
        id: r.id,
        name: r.name,
        type: r.type,
        content: r.content,
        ttl: r.ttl,
        proxied: r.proxied,
      };
    },

    async upsertRecord(zoneId, record) {
      const existing = await this.findRecord(zoneId, record.name, record.type);
      const body = {
        type: record.type,
        name: record.name,
        content: record.content,
        ttl: record.ttl || 1, // 1 = "automatic" per CF
        proxied: record.proxied === true,
        comment: record.comment || "Managed by WCN Cloud",
      };
      const res = existing
        ? await call("PUT", `/zones/${zoneId}/dns_records/${existing.id}`, body)
        : await call("POST", `/zones/${zoneId}/dns_records`, body);
      const r = res.result;
      return {
        id: r.id,
        name: r.name,
        type: r.type,
        content: r.content,
        ttl: r.ttl,
        proxied: r.proxied,
      };
    },

    async deleteRecord(zoneId, recordId) {
      try {
        await call("DELETE", `/zones/${zoneId}/dns_records/${recordId}`);
      } catch (e) {
        // 404 on delete is fine — record already gone.
        if (e.upstream_status === 404) return;
        throw e;
      }
    },
  };
}

module.exports = { create };
