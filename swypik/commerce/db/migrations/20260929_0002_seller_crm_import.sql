-- Idempotent CRM/customer imports from connected commerce platforms.

BEGIN;

ALTER TABLE seller_clients
  ADD COLUMN IF NOT EXISTS external_source text,
  ADD COLUMN IF NOT EXISTS external_account_id text,
  ADD COLUMN IF NOT EXISTS external_customer_id text,
  ADD COLUMN IF NOT EXISTS country text,
  ADD COLUMN IF NOT EXISTS postal_code text,
  ADD COLUMN IF NOT EXISTS last_synced_at timestamptz;

ALTER TABLE seller_catalog_integrations
  ADD COLUMN IF NOT EXISTS last_customer_sync_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_customer_sync_cursor text,
  ADD COLUMN IF NOT EXISTS last_customer_error_code text;

DO $$ BEGIN
  ALTER TABLE seller_clients
    ADD CONSTRAINT seller_clients_external_source_check
    CHECK (external_source IS NULL OR external_source IN ('shopify', 'woocommerce'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_seller_clients_external
  ON seller_clients (seller_id, external_source, external_account_id, external_customer_id)
  WHERE external_source IS NOT NULL
    AND external_account_id IS NOT NULL
    AND external_customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_seller_clients_external_lookup
  ON seller_clients (seller_id, external_source, external_account_id);

COMMIT;
