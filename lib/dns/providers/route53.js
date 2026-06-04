// AWS Route 53 DNS client. SigV4-signs requests directly so we don't
// have to pull in the AWS SDK (~50MB). Route 53 is a global service
// hosted under us-east-1.

const crypto = require("crypto");

const SERVICE = "route53";
const HOST = "route53.amazonaws.com";
const BASE = `https://${HOST}/2013-04-01`;

function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}
function hmac(key, data) {
  return crypto.createHmac("sha256", key).update(data).digest();
}

function signRequest({ method, path, query, headers, body, access_key, secret_key, region }) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);

  const canonicalQuery = Object.keys(query || {})
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`)
    .join("&");

  headers["host"] = HOST;
  headers["x-amz-date"] = amzDate;
  if (body) headers["x-amz-content-sha256"] = sha256(body);

  const signedHeaderNames = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const canonicalHeaders =
    signedHeaderNames.map((h) => `${h}:${String(headers[h]).trim()}`).join("\n") + "\n";
  const signedHeaders = signedHeaderNames.join(";");

  const canonicalRequest = [
    method,
    path,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    body ? sha256(body) : sha256(""),
  ].join("\n");

  const credentialScope = `${dateStamp}/${region}/${SERVICE}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256(canonicalRequest)].join("\n");

  const kDate = hmac("AWS4" + secret_key, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, SERVICE);
  const kSigning = hmac(kService, "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  headers["authorization"] = `AWS4-HMAC-SHA256 Credential=${access_key}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { url: `${BASE}${path}${canonicalQuery ? "?" + canonicalQuery : ""}`, headers };
}

function parseXmlChunks(xml, tag) {
  // Tiny XML extractor — pulls top-level <tag>...</tag> chunks.
  const out = [];
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}
function parseXmlField(chunk, tag) {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(chunk);
  return m ? m[1] : null;
}

function create(credentials) {
  const access_key = String(credentials.access_key_id || "").trim();
  const secret_key = String(credentials.secret_access_key || "").trim();
  const region = String(credentials.region || "us-east-1").trim();
  if (!access_key || !secret_key) throw new Error("route53: access_key_id + secret_access_key required");

  async function call(method, path, body, query) {
    const headers = {};
    if (body) headers["content-type"] = "text/xml";
    const { url, headers: signed } = signRequest({
      method,
      path,
      query: query || {},
      headers,
      body,
      access_key,
      secret_key,
      region,
    });
    const res = await fetch(url, { method, headers: signed, body });
    const text = await res.text();
    if (!res.ok) {
      const msg = parseXmlField(text, "Message") || `route53 ${res.status}`;
      const err = new Error(msg);
      err.upstream_status = res.status;
      throw err;
    }
    return text;
  }

  return {
    provider: "route53",

    async test() {
      try {
        await call("GET", "/hostedzone", null, { maxitems: "1" });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    async listZones() {
      const out = [];
      let marker = null;
      while (true) {
        const q = { maxitems: "100" };
        if (marker) q.marker = marker;
        const xml = await call("GET", "/hostedzone", null, q);
        const chunks = parseXmlChunks(xml, "HostedZone");
        for (const c of chunks) {
          const idFull = parseXmlField(c, "Id"); // "/hostedzone/Z123..."
          const id = idFull ? idFull.replace("/hostedzone/", "") : "";
          const name = (parseXmlField(c, "Name") || "").replace(/\.$/, "");
          out.push({
            id,
            name,
            capabilities: { alias: true, cname_flattening: false },
          });
        }
        const truncated = parseXmlField(xml, "IsTruncated") === "true";
        if (!truncated) break;
        marker = parseXmlField(xml, "NextMarker");
      }
      return out;
    },

    async findRecord(zoneId, name, type) {
      const fqdn = name.endsWith(".") ? name : name + ".";
      const xml = await call("GET", `/hostedzone/${zoneId}/rrset`, null, {
        name: fqdn,
        type,
        maxitems: "1",
      });
      const chunks = parseXmlChunks(xml, "ResourceRecordSet");
      const c = chunks[0];
      if (!c) return null;
      const recName = (parseXmlField(c, "Name") || "").replace(/\.$/, "");
      if (recName !== name) return null;
      const recType = parseXmlField(c, "Type");
      if (recType !== type) return null;
      const value = parseXmlField(parseXmlField(c, "ResourceRecords") || "", "Value");
      return {
        id: `${recName}|${recType}`,
        name: recName,
        type: recType,
        content: value,
        ttl: parseInt(parseXmlField(c, "TTL") || "300", 10),
      };
    },

    async upsertRecord(zoneId, record) {
      const fqdn = record.name.endsWith(".") ? record.name : record.name + ".";
      const ttl = record.ttl && record.ttl > 1 ? record.ttl : 300;
      const body = `<?xml version="1.0" encoding="UTF-8"?>
<ChangeResourceRecordSetsRequest xmlns="https://route53.amazonaws.com/doc/2013-04-01/">
  <ChangeBatch>
    <Comment>Managed by WCN Cloud</Comment>
    <Changes>
      <Change>
        <Action>UPSERT</Action>
        <ResourceRecordSet>
          <Name>${fqdn}</Name>
          <Type>${record.type}</Type>
          <TTL>${ttl}</TTL>
          <ResourceRecords>
            <ResourceRecord>
              <Value>${record.content}</Value>
            </ResourceRecord>
          </ResourceRecords>
        </ResourceRecordSet>
      </Change>
    </Changes>
  </ChangeBatch>
</ChangeResourceRecordSetsRequest>`;
      await call("POST", `/hostedzone/${zoneId}/rrset`, body);
      return {
        id: `${record.name}|${record.type}`,
        name: record.name,
        type: record.type,
        content: record.content,
        ttl,
      };
    },

    async deleteRecord(zoneId, recordId) {
      // recordId is "<name>|<type>" — fetch current value, then DELETE with it.
      const [name, type] = recordId.split("|");
      const existing = await this.findRecord(zoneId, name, type);
      if (!existing) return; // already gone
      const fqdn = name.endsWith(".") ? name : name + ".";
      const body = `<?xml version="1.0" encoding="UTF-8"?>
<ChangeResourceRecordSetsRequest xmlns="https://route53.amazonaws.com/doc/2013-04-01/">
  <ChangeBatch>
    <Comment>Managed by WCN Cloud</Comment>
    <Changes>
      <Change>
        <Action>DELETE</Action>
        <ResourceRecordSet>
          <Name>${fqdn}</Name>
          <Type>${type}</Type>
          <TTL>${existing.ttl}</TTL>
          <ResourceRecords>
            <ResourceRecord>
              <Value>${existing.content}</Value>
            </ResourceRecord>
          </ResourceRecords>
        </ResourceRecordSet>
      </Change>
    </Changes>
  </ChangeBatch>
</ChangeResourceRecordSetsRequest>`;
      await call("POST", `/hostedzone/${zoneId}/rrset`, body);
    },
  };
}

module.exports = { create };
