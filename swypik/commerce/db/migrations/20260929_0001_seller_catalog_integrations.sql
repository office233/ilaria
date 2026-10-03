-- Seller catalog integrations (Shopify / WooCommerce).
-- Credentials are encrypted by the application before INSERT.

BEGIN;

ALTER TABLE marketplace_products
  DROP CONSTRAINT IF EXISTS marketplace_products_source_type_check;

ALTER TABLE marketplace_products
  ADD CONSTRAINT marketplace_products_source_type_check
  CHECK (
    source_type = ANY (
      ARRAY[
        'seller',
        'aliexpress',
        'affiliate',
        'manual',
        'other',
        'meister_erp',
        'multi_erp',
        'shopify',
        'woocommerce'
      ]
    )
  );

CREATE TABLE IF NOT EXISTS seller_catalog_integrations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id           uuid NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  provider            text NOT NULL CHECK (provider IN ('shopify', 'woocommerce')),
  external_account_id text NOT NULL,
  credentials_enc     text NOT NULL,
  config              jsonb NOT NULL DEFAULT '{}'::jsonb,
  status              text NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'disabled', 'error')),
  last_sync_at        timestamptz,
  last_sync_cursor    text,
  last_error_code     text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (seller_id, provider, external_account_id),
  UNIQUE (provider, external_account_id)
);

CREATE INDEX IF NOT EXISTS idx_seller_catalog_integrations_seller_status
  ON seller_catalog_integrations (seller_id, status, updated_at DESC);

COMMIT;
