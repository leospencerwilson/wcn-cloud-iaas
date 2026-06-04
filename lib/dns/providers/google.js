// Google Cloud DNS client. Exchanges a service account JSON for an
// OAuth2 access token via JWT bearer flow, then calls the v1 REST API.
// API: https://cloud.google.com/dns/docs/reference/v1
//
// We cache the access token in-memory for ~50 minutes (tokens last 1h).

const crypto = require("crypto");

const TOKEN_TTL_MS = 50 * 60 * 1000;

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function getAccessToken(sa) {
  if (sa._token && sa._token_expires_at > Date.now()) return sa._token;
  const nowSec = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: sa.private_key_id }));
  const claim = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/ndev.clouddns.readwrite",
      aud: "https://oauth2.googleapis.com/token",
      iat: nowSec,
      exp: nowSec + 3600,
    }),
  );
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${header}.${claim}`);
  const sig = b64url(signer.sign(sa.private_key));
  const jwt = `${header}.${claim}.${sig}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`google oauth: ${data.error_description || data.error || res.status}`);
  }
  sa._token = data.access_token;
  sa._token_expires_at = Date.now() + TOKEN_TTL_MS;
  return data.access_token;
}

function create(credentials) {
  let sa;
  try {
    sa =
      typeof credentials.service_account_json === "string"
        ? JSON.parse(credentials.service_account_json)
        : credentials.service_account_json;
  } catch (e) {
    throw new Error(`google: service_account_json is not valid JSON (${e.message})`);
  }
  if (!sa || !sa.client_email || !sa.private_key) {
    throw new Error("google: service_account_json missing client_email or private_key");
  }
  const projectId = sa.project_id;

  async function call(method, path, body) {
    const token = await getAccessToken(sa);
    const res = await fetch(`https://dns.googleapis.com/dns/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (data.error && data.error.message) || `google ${res.status}`;
      const err = new Error(msg);
      err.upstream_status = res.status;
      throw err;
    }
    return data;
  }

  return {
    provider: "google",

    async test() {
      try {
        await call("GET", `/projects/${projectId}/managedZones?maxResults=1`);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    async listZones() {
      const out = [];
      let pageToken = null;
      do {
        const q = `maxResults=50${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
        const data = await call("GET", `/projects/${projectId}/managedZones?${q}`);
        for (const z of data.managedZones || []) {
          out.push({
            id: z.name, // GCP uses the managedZone NAME as its identifier
            name: (z.dnsName || "").replace(/\.$/, ""),
            capabilities: { alias: false, cname_flattening: false },
          });
        }
        pageToken = data.nextPageToken || null;
      } while (pageToken);
      return out;
    },

    async findRecord(zoneId, name, type) {
      const fqdn = name.endsWith(".") ? name : name + ".";
      const data = await call(
        "GET",
        `/projects/${projectId}/managedZones/${zoneId}/rrsets?name=${encodeURIComponent(fqdn)}&type=${type}`,
      );
      const r = (data.rrsets || [])[0];
      if (!r) return null;
      return {
        id: `${r.name}|${r.type}`,
        name: r.name.replace(/\.$/, ""),
        type: r.type,
        content: (r.rrdatas || [])[0] || "",
        ttl: r.ttl,
      };
    },

    async upsertRecord(zoneId, record) {
      const fqdn = record.name.endsWith(".") ? record.name : record.name + ".";
      const ttl = record.ttl && record.ttl > 1 ? record.ttl : 300;
      // GCP CNAME rrdatas must be fully-qualified.
      const content =
        record.type === "CNAME" && !record.content.endsWith(".")
          ? record.content + "."
          : record.content;

      const existing = await this.findRecord(zoneId, record.name, record.type);
      const change = { additions: [{ name: fqdn, type: record.type, ttl, rrdatas: [content] }] };
      if (existing) {
        change.deletions = [
          {
            name: fqdn,
            type: record.type,
            ttl: existing.ttl,
            rrdatas: [existing.content.endsWith(".") ? existing.content : existing.content + "."],
          },
        ];
      }
      await call("POST", `/projects/${projectId}/managedZones/${zoneId}/changes`, change);
      return {
        id: `${fqdn}|${record.type}`,
        name: record.name,
        type: record.type,
        content,
        ttl,
      };
    },

    async deleteRecord(zoneId, recordId) {
      const [nameRaw, type] = recordId.split("|");
      const name = nameRaw.replace(/\.$/, "");
      const existing = await this.findRecord(zoneId, name, type);
      if (!existing) return;
      const fqdn = name.endsWith(".") ? name : name + ".";
      const rrdata = existing.content.endsWith(".") ? existing.content : existing.content + ".";
      await call("POST", `/projects/${projectId}/managedZones/${zoneId}/changes`, {
        deletions: [{ name: fqdn, type, ttl: existing.ttl, rrdatas: [rrdata] }],
      });
    },
  };
}

module.exports = { create };
