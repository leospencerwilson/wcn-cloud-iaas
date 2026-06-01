-- 2026-05-30  Customer settings sub-page fields + archive support.
-- Idempotent; safe to re-run.

BEGIN;

ALTER TABLE customers ADD COLUMN IF NOT EXISTS billing_contact_email   text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS billing_contact_name    text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS technical_contact_email text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS technical_contact_name  text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS billing_address         text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS vat_number              text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS go_live_date            date;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS archived_at             timestamptz;

-- notes already exists on the base schema; ensure presence anyway.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS notes                   text;

-- Permit 'archived' status.
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_status_check;
ALTER TABLE customers ADD  CONSTRAINT customers_status_check
  CHECK (status IN ('provisioning', 'active', 'suspended', 'deleted', 'archived'));

COMMIT;
