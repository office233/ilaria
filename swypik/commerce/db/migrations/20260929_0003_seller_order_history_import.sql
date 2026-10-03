-- Historical order/sales imports from connected Shopify / WooCommerce stores.
--
-- These tables are intentionally separate from commerce_orders. Imported
-- history is read-only analytics data and must never enter Swypik fulfillment,
-- payout, returns or notification workflows.

BEGIN;

ALTER TABLE seller_catalog_integrations
  ADD COLUMN IF NOT EXISTS last_order_sync_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_order_sync_cursor text,
  ADD COLUMN IF NOT EXISTS last_order_error_code text;

CREATE TABLE IF NOT EXISTS seller_imported_orders (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id             uuid NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  integration_id        uuid REFERENCES seller_catalog_integrations(id) ON DELETE SET NULL,
  provider              text NOT NULL CHECK (provider IN ('shopify', 'woocommerce')),
  external_account_id   text NOT NULL,
  external_order_id     text NOT NULL,
  order_number          text,
  normalized_status     text NOT NULL
                        CHECK (normalized_status IN (
                          'open', 'paid', 'fulfilled', 'cancelled', 'refunded',
                          'partially_refunded', 'failed', 'unknown'
                        )),
  provider_status       text,
  financial_status      text,
  fulfillment_status    text,
  currency              char(3) NOT NULL,
  subtotal_cents        bigint NOT NULL DEFAULT 0 CHECK (subtotal_cents >= 0),
  discount_cents        bigint NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  shipping_cents        bigint NOT NULL DEFAULT 0 CHECK (shipping_cents >= 0),
  tax_cents             bigint NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  total_cents           bigint NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  refunded_cents        bigint NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0),
  customer_external_id  text,
  customer_name         text,
  customer_email        text,
  customer_phone        text,
  placed_at             timestamptz NOT NULL,
  cancelled_at          timestamptz,
  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at        timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (seller_id, provider, external_account_id, external_order_id)
);

CREATE INDEX IF NOT EXISTS idx_seller_imported_orders_seller_placed
  ON seller_imported_orders (seller_id, placed_at DESC);
CREATE INDEX IF NOT EXISTS idx_seller_imported_orders_seller_status
  ON seller_imported_orders (seller_id, normalized_status, placed_at DESC);
CREATE INDEX IF NOT EXISTS idx_seller_imported_orders_integration
  ON seller_imported_orders (integration_id, placed_at DESC);

CREATE TABLE IF NOT EXISTS seller_imported_order_items (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id              uuid NOT NULL REFERENCES seller_imported_orders(id) ON DELETE CASCADE,
  external_line_item_id text NOT NULL,
  external_product_id   text,
  external_variant_id   text,
  title                 text NOT NULL,
  sku                   text,
  quantity              integer NOT NULL CHECK (quantity > 0),
  currency              char(3) NOT NULL,
  unit_amount_cents     bigint NOT NULL DEFAULT 0 CHECK (unit_amount_cents >= 0),
  total_amount_cents    bigint NOT NULL DEFAULT 0 CHECK (total_amount_cents >= 0),
  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, external_line_item_id)
);

CREATE INDEX IF NOT EXISTS idx_seller_imported_order_items_order
  ON seller_imported_order_items (order_id, created_at);
CREATE INDEX IF NOT EXISTS idx_seller_imported_order_items_product
  ON seller_imported_order_items (external_product_id)
  WHERE external_product_id IS NOT NULL;

COMMIT;
