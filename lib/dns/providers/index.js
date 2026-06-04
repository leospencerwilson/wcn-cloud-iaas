// DNS provider abstraction. Each client implements the same async surface
// so the rest of the system never branches on provider. New providers go
// into ./<name>.js and get registered in PROVIDERS.
//
// Credentials are passed as an already-decrypted JSON object. Encryption
// + storage is the caller's responsibility (see lib/db/dns-integrations).

const cloudflare = require("./cloudflare");
const route53 = require("./route53");
const google = require("./google");
const vercel = require("./vercel");
const digitalocean = require("./digitalocean");

const PROVIDERS = {
  cloudflare,
  route53,
  google,
  vercel,
  digitalocean,
};

const PROVIDER_KEYS = Object.keys(PROVIDERS);

// Public metadata so the UI knows what fields to render in the connect form.
// Each `fields` entry is { name, label, type, hint }.
const PROVIDER_META = {
  cloudflare: {
    label: "Cloudflare",
    docs_url: "https://dash.cloudflare.com/profile/api-tokens",
    fields: [
      {
        name: "api_token",
        label: "API token",
        type: "password",
        hint: 'Create a token with "Zone:DNS:Edit" + "Zone:Zone:Read" scopes for the zones you want to manage.',
      },
    ],
    apex_supported: true,
  },
  route53: {
    label: "AWS Route 53",
    docs_url: "https://docs.aws.amazon.com/IAM/latest/UserGuide/id_users_create.html",
    fields: [
      { name: "access_key_id", label: "Access key ID", type: "text" },
      { name: "secret_access_key", label: "Secret access key", type: "password" },
      {
        name: "region",
        label: "Region (optional)",
        type: "text",
        hint: 'Route 53 is global, but the SDK still wants a region. Defaults to "us-east-1".',
      },
    ],
    apex_supported: false,
  },
  google: {
    label: "Google Cloud DNS",
    docs_url:
      "https://cloud.google.com/dns/docs/zones/manage-records-using-api#authentication",
    fields: [
      {
        name: "service_account_json",
        label: "Service account JSON",
        type: "textarea",
        hint: 'Paste the JSON for a service account with "DNS Administrator" on the project. We use it server-side only.',
      },
    ],
    apex_supported: false,
  },
  vercel: {
    label: "Vercel",
    docs_url: "https://vercel.com/account/tokens",
    fields: [
      { name: "api_token", label: "API token", type: "password" },
      {
        name: "team_id",
        label: "Team ID (optional)",
        type: "text",
        hint: 'Required if the token belongs to a team. Find it under Team Settings → General.',
      },
    ],
    apex_supported: true,
  },
  digitalocean: {
    label: "DigitalOcean",
    docs_url: "https://cloud.digitalocean.com/account/api/tokens",
    fields: [
      { name: "api_token", label: "Personal access token", type: "password" },
    ],
    apex_supported: false,
  },
};

function buildClient(provider, credentials) {
  const mod = PROVIDERS[provider];
  if (!mod) throw new Error(`unknown DNS provider: ${provider}`);
  return mod.create(credentials);
}

module.exports = {
  PROVIDERS,
  PROVIDER_KEYS,
  PROVIDER_META,
  buildClient,
};
