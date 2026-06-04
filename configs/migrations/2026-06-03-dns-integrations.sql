-- Customer-owned DNS provider credentials. One row per (customer_slug,
-- provider, display_name). Credentials are stored as ciphertext blobs
-- encrypted at the app layer with INTEGRATION_ENC_KEY (same key as
-- github_integrations) — server-side decrypt happens only inside the
-- provisioner DNS-client when it needs to call the upstream API.
--
-- zones_cache is a denormalised JSON snapshot of the provider's zone
-- list so the console can match a customer-entered hostname against
-- their connected zones without making a live API call on every render.

CREATE TABLE IF NOT EXISTS dns_integrations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_slug       text NOT NULL REFERENCES customers(slug),
  provider            text NOT NULL CHECK (provider IN (
                        'cloudflare', 'route53', 'google', 'vercel', 'digitalocean'
                      )),
  display_name        text NOT NULL,
  encrypted_credentials text NOT NULL,
  zones_cache         jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_zone_sync_at   timestamptz,
  last_test_at        timestamptz,
  last_test_ok        boolean,
  last_test_error     text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          text,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dns_integrations_slug_idx
  ON dns_integrations (customer_slug);

CREATE UNIQUE INDEX IF NOT EXISTS dns_integrations_slug_name_uq
  ON dns_integrations (customer_slug, display_name);

-- Link a managed DNS record back to the integration that owns it so
-- we can clean it up when the domain is removed. dns_record_id is
-- provider-specific (Cloudflare uses UUIDs, Route53 uses synthetic IDs).
ALTER TABLE domains
  ADD COLUMN IF NOT EXISTS dns_integration_id uuid REFERENCES dns_integrations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS dns_record_id      text,
  ADD COLUMN IF NOT EXISTS dns_zone_id        text;

CREATE INDEX IF NOT EXISTS domains_dns_integration_idx
  ON domains (dns_integration_id) WHERE dns_integration_id IS NOT NULL;
