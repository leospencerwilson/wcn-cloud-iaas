-- 2026-06-03 github_integrations
-- One row per customer storing their OAuth access token (encrypted at rest)
-- against github.com. Used by the New App form to populate the private-repo
-- dropdown and (next session) by Coolify to clone private repos during build.

CREATE TABLE IF NOT EXISTS github_integrations (
    id              BIGSERIAL PRIMARY KEY,
    customer_slug   TEXT        NOT NULL
        REFERENCES customers(slug) ON DELETE CASCADE,
    github_user_id  BIGINT      NOT NULL,
    github_login    TEXT        NOT NULL,
    -- AES-256-GCM ciphertext. First 12 bytes IV, last 16 bytes auth tag,
    -- middle bytes are the ciphertext of the OAuth access token.
    encrypted_token BYTEA       NOT NULL,
    scopes          TEXT[]      NOT NULL DEFAULT '{}',
    connected_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at    TIMESTAMPTZ,
    disconnected_at TIMESTAMPTZ,
    -- Whoever (in the console) initiated the OAuth flow — surfaces in audit.
    connected_by_email TEXT
);

-- One active integration per customer; reconnect overwrites.
CREATE UNIQUE INDEX IF NOT EXISTS github_integrations_active_slug
    ON github_integrations (customer_slug)
    WHERE disconnected_at IS NULL;

CREATE INDEX IF NOT EXISTS github_integrations_github_login
    ON github_integrations (github_login);

COMMENT ON TABLE github_integrations IS
    'Per-customer GitHub OAuth integration. encrypted_token is AES-256-GCM, key from INTEGRATION_ENC_KEY env.';
