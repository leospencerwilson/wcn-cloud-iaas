-- WCN Cloud ops database — tiers table.
-- Postgres ≥ 15. Idempotent. Apply: psql "$OPS_DB_URL" < ops-db-tiers.sql
--
-- TODO(follow-up): add FK customers.tier → tiers.id once the existing
-- customers.tier free-text column has been audited/normalised against the
-- seeded tier slugs. The legacy CHECK constraint in ops-db-schema.sql also
-- needs to be relaxed before that FK can be added.

BEGIN;

CREATE TABLE IF NOT EXISTS tiers (
    id                   text         PRIMARY KEY
                                      CHECK (id ~ '^[a-z0-9-]{2,40}$'),
    display_name         text         NOT NULL,
    vcpu                 int          NOT NULL CHECK (vcpu > 0),
    ram_mb               int          NOT NULL CHECK (ram_mb > 0),
    disk_gb              int          NOT NULL CHECK (disk_gb > 0),
    price_gbp_monthly    int          NOT NULL CHECK (price_gbp_monthly >= 0),
    backup_cadence       text         NOT NULL DEFAULT 'nightly',
    sla                  text         NOT NULL DEFAULT 'best-effort',
    features             jsonb        NOT NULL DEFAULT '{}'::jsonb,
    archived             boolean      NOT NULL DEFAULT false,
    created_at           timestamptz  NOT NULL DEFAULT now(),
    updated_at           timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tiers_archived_idx ON tiers (archived);

INSERT INTO tiers (id, display_name, vcpu, ram_mb, disk_gb, price_gbp_monthly, backup_cadence, sla)
VALUES
    ('site',    'Site',     2, 4096,  40,  49, 'nightly', 'best-effort'),
    ('site-db', 'Site + DB', 4, 8192,  80, 129, 'nightly', 'best-effort'),
    ('pro',     'Pro',      8, 16384, 160, 349, 'nightly', '99.5%')
ON CONFLICT (id) DO NOTHING;

COMMIT;
