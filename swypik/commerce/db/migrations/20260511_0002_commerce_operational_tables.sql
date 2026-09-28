CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- 2026-08-10 (audit P2): tot fișierul înfășurat în tranzacție — DDL parțial
-- aplicat la o întrerupere lăsa schema inconsistentă.
BEGIN;

CREATE TABLE IF NOT EXISTS carts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_cart_id text UNIQUE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'checkout_started', 'ordered', 'abandoned', 'expired')),
  currency char(3) NOT NULL DEFAULT 'RON',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS carts_user_status_idx
  ON carts (user_id, status, created_at DESC)
  WHERE user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS cart_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id uuid NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  external_product_id text NOT NULL,
  external_variant_id text,
  marketplace_product_id uuid REFERENCES marketplace_products(id) ON DELETE SET NULL,
  marketplace_variant_id uuid REFERENCES marketplace_product_variants(id) ON DELETE SET NULL,
  title text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  currency char(3) NOT NULL DEFAULT 'RON',
  unit_amount_cents integer NOT NULL CHECK (unit_amount_cents >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS cart_items_cart_external_variant_uidx
  ON cart_items (cart_id, external_product_id, coalesce(external_variant_id, ''))
  WHERE metadata->>'mergeable' = 'true';
CREATE INDEX IF NOT EXISTS cart_items_cart_idx
  ON cart_items (cart_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS commerce_orders_pending_cart_uidx
  ON commerce_orders ((metadata->>'cart_id'))
  WHERE status = 'pending' AND metadata ? 'cart_id';

CREATE TABLE IF NOT EXISTS supplier_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  commerce_order_id uuid NOT NULL REFERENCES commerce_orders(id) ON DELETE CASCADE,
  supplier text NOT NULL CHECK (supplier IN ('aliexpress', 'seller', 'manual', 'other')),
  supplier_order_id text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'submitted', 'accepted', 'processing', 'shipped', 'delivered', 'cancelled', 'failed', 'refunded')),
  currency char(3) NOT NULL DEFAULT 'RON',
  supplier_cost_cents integer CHECK (supplier_cost_cents IS NULL OR supplier_cost_cents >= 0),
  shipping_cost_cents integer CHECK (shipping_cost_cents IS NULL OR shipping_cost_cents >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS supplier_orders_supplier_external_uidx
  ON supplier_orders (supplier, supplier_order_id)
  WHERE supplier_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS supplier_orders_order_status_idx
  ON supplier_orders (commerce_order_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS supplier_order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_order_id uuid NOT NULL REFERENCES supplier_orders(id) ON DELETE CASCADE,
  commerce_order_item_id uuid REFERENCES commerce_order_items(id) ON DELETE SET NULL,
  external_product_id text,
  external_variant_id text,
  title text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  currency char(3) NOT NULL DEFAULT 'RON',
  supplier_unit_cost_cents integer CHECK (supplier_unit_cost_cents IS NULL OR supplier_unit_cost_cents >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS supplier_order_items_supplier_order_idx
  ON supplier_order_items (supplier_order_id, created_at);
CREATE INDEX IF NOT EXISTS supplier_order_items_commerce_item_idx
  ON supplier_order_items (commerce_order_item_id)
  WHERE commerce_order_item_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS fulfillment_shipments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  commerce_order_id uuid NOT NULL REFERENCES commerce_orders(id) ON DELETE CASCADE,
  supplier_order_id uuid REFERENCES supplier_orders(id) ON DELETE SET NULL,
  carrier text,
  tracking_number text,
  tracking_url text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'label_created', 'in_transit', 'delivered', 'exception', 'returned', 'cancelled')),
  shipped_at timestamptz,
  delivered_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fulfillment_shipments_order_status_idx
  ON fulfillment_shipments (commerce_order_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS fulfillment_shipments_tracking_idx
  ON fulfillment_shipments (carrier, tracking_number)
  WHERE tracking_number IS NOT NULL;

CREATE TABLE IF NOT EXISTS tracking_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id uuid NOT NULL REFERENCES fulfillment_shipments(id) ON DELETE CASCADE,
  status text NOT NULL,
  message text,
  location text,
  occurred_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tracking_events_shipment_occurred_idx
  ON tracking_events (shipment_id, occurred_at DESC);

ALTER TABLE marketplace_merchants
  ADD COLUMN IF NOT EXISTS onboarding_status text NOT NULL DEFAULT 'not_started'
    CHECK (onboarding_status IN ('not_started', 'pending', 'verified', 'rejected', 'disabled')),
  ADD COLUMN IF NOT EXISTS commission_rate_bps integer
    CHECK (commission_rate_bps IS NULL OR commission_rate_bps BETWEEN 0 AND 10000),
  ADD COLUMN IF NOT EXISTS payout_provider text,
  ADD COLUMN IF NOT EXISTS payout_account_ref text,
  ADD COLUMN IF NOT EXISTS shipping_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS return_policy jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE marketplace_products
  ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'seller'
    CHECK (source_type IN ('seller', 'aliexpress', 'affiliate', 'manual', 'other')),
  ADD COLUMN IF NOT EXISTS supplier text,
  ADD COLUMN IF NOT EXISTS supplier_product_id text,
  ADD COLUMN IF NOT EXISTS supplier_url text,
  ADD COLUMN IF NOT EXISTS supplier_cost_cents integer
    CHECK (supplier_cost_cents IS NULL OR supplier_cost_cents >= 0);

CREATE UNIQUE INDEX IF NOT EXISTS marketplace_products_supplier_uidx
  ON marketplace_products (source_type, supplier, supplier_product_id)
  WHERE supplier_product_id IS NOT NULL;

INSERT INTO schema_migrations (version)
VALUES ('20260511_0002_commerce_operational_tables')
ON CONFLICT (version) DO NOTHING;

COMMIT;
