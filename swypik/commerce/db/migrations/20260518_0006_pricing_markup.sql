-- Migration 20260518_0006_pricing_markup
-- Adds supplier_cost_cents + shipping_cost_cents on variants, populates from AE metadata.
-- Recalculates marketplace_products price_cents with tiered markup + TVA 21% + shipping.
--
-- Pricing model:
--   supplier_cost_cents  = round(ae_price_usd * fx_usd_ron * 100)   [RON minor units]
--   shipping_cost_cents  = derived from ae_package.gross_weight (kg)
--   total_cost_cents     = supplier_cost_cents + shipping_cost_cents
--   markup tier (RON):
--     total_cost < 2500   -> 3.0x
--     2500..9999          -> 2.0x
--     >= 10000            -> 1.7x
--   price_cents = round(total_cost * markup * 1.21)           [TVA 21%]
--   compare_at  = round(price_cents * 1.30)                   [discount effect ~23%]
--
-- Constants:
--   fx_usd_ron       = 4.60  (TODO: cron-update from BNR)
--   shipping tiers (USD, converted at same fx):
--     <= 0.2 kg -> $2     |  0.2-0.5 kg -> $3
--     0.5-1.0 kg -> $5    |  > 1.0 kg   -> $8
--     unknown weight -> $3 (median fallback)

BEGIN;

-- ============================================================
-- 1. SCHEMA: add cost + shipping columns
-- ============================================================
ALTER TABLE marketplace_products
  ADD COLUMN IF NOT EXISTS shipping_cost_cents integer
    CHECK (shipping_cost_cents IS NULL OR shipping_cost_cents >= 0);

ALTER TABLE marketplace_product_variants
  ADD COLUMN IF NOT EXISTS supplier_cost_cents integer
    CHECK (supplier_cost_cents IS NULL OR supplier_cost_cents >= 0),
  ADD COLUMN IF NOT EXISTS shipping_cost_cents integer
    CHECK (shipping_cost_cents IS NULL OR shipping_cost_cents >= 0);

-- ============================================================
-- 2. BACKFILL VARIANTS: supplier_cost_cents from ae_price_usd
-- ============================================================
UPDATE marketplace_product_variants mpv
SET supplier_cost_cents = ROUND(
      ((mpv.metadata->>'ae_price_usd')::numeric) * 4.60 * 100
    )::int
WHERE mpv.metadata ? 'ae_price_usd'
  AND mpv.supplier_cost_cents IS NULL;

-- ============================================================
-- 3. BACKFILL VARIANTS: shipping_cost_cents from parent ae_package weight
-- ============================================================
UPDATE marketplace_product_variants mpv
SET shipping_cost_cents = (
  CASE
    WHEN COALESCE((mp.metadata->'ae_package'->>'gross_weight')::numeric, 0) <= 0     THEN 1380  -- fallback $3
    WHEN ((mp.metadata->'ae_package'->>'gross_weight')::numeric) <= 0.20             THEN  920  -- $2
    WHEN ((mp.metadata->'ae_package'->>'gross_weight')::numeric) <= 0.50             THEN 1380  -- $3
    WHEN ((mp.metadata->'ae_package'->>'gross_weight')::numeric) <= 1.00             THEN 2300  -- $5
    ELSE 3680                                                                                   -- $8
  END
)
FROM marketplace_products mp
WHERE mp.id = mpv.product_id
  AND mp.supplier = 'aliexpress'
  AND mpv.shipping_cost_cents IS NULL;

-- ============================================================
-- 4. BACKFILL MARKETPLACE_PRODUCTS:
--    supplier_cost_cents = MIN(variants.supplier_cost_cents)
--    shipping_cost_cents = matching variant's shipping
-- ============================================================
WITH min_var AS (
  SELECT DISTINCT ON (product_id)
    product_id,
    supplier_cost_cents,
    shipping_cost_cents
  FROM marketplace_product_variants
  WHERE supplier_cost_cents IS NOT NULL
  ORDER BY product_id, supplier_cost_cents ASC, id
)
UPDATE marketplace_products mp
SET
  supplier_cost_cents = mv.supplier_cost_cents,
  shipping_cost_cents = mv.shipping_cost_cents
FROM min_var mv
WHERE mp.id = mv.product_id
  AND mp.supplier = 'aliexpress';

-- ============================================================
-- 5. RECALCULATE price_cents with tiered markup + TVA
-- ============================================================
UPDATE marketplace_products mp
SET price_cents = ROUND(
  (COALESCE(supplier_cost_cents,0) + COALESCE(shipping_cost_cents,0))
  * CASE
      WHEN (COALESCE(supplier_cost_cents,0) + COALESCE(shipping_cost_cents,0)) <  2500  THEN 3.00
      WHEN (COALESCE(supplier_cost_cents,0) + COALESCE(shipping_cost_cents,0)) < 10000  THEN 2.00
      ELSE                                                                                   1.70
    END
  * 1.21
)::int
WHERE mp.supplier = 'aliexpress'
  AND mp.supplier_cost_cents IS NOT NULL;

-- 5b. Same recalc on variants (so variant detail/checkout uses consistent prices)
UPDATE marketplace_product_variants mpv
SET price_cents = ROUND(
  (COALESCE(supplier_cost_cents,0) + COALESCE(shipping_cost_cents,0))
  * CASE
      WHEN (COALESCE(supplier_cost_cents,0) + COALESCE(shipping_cost_cents,0)) <  2500  THEN 3.00
      WHEN (COALESCE(supplier_cost_cents,0) + COALESCE(shipping_cost_cents,0)) < 10000  THEN 2.00
      ELSE                                                                                   1.70
    END
  * 1.21
)::int
WHERE mpv.supplier_cost_cents IS NOT NULL;

-- ============================================================
-- 6. compare_at_price_cents = price * 1.30 (discount effect ~23%)
-- ============================================================
UPDATE marketplace_products
SET compare_at_price_cents = ROUND(price_cents * 1.30)::int
WHERE supplier = 'aliexpress'
  AND price_cents IS NOT NULL
  AND compare_at_price_cents IS NULL;

-- ============================================================
-- 7. SAFETY CONSTRAINT: price must cover cost + shipping
--    (allow NULL costs for non-supplier products)
-- ============================================================
ALTER TABLE marketplace_products
  DROP CONSTRAINT IF EXISTS marketplace_products_price_ge_cost_check;

ALTER TABLE marketplace_products
  ADD CONSTRAINT marketplace_products_price_ge_cost_check CHECK (
    supplier_cost_cents IS NULL
    OR price_cents IS NULL
    OR price_cents >= (COALESCE(supplier_cost_cents,0) + COALESCE(shipping_cost_cents,0))
  );

-- ============================================================
-- 8. INDEXES for new cost lookups
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_mp_supplier_cost
  ON marketplace_products(supplier_cost_cents)
  WHERE supplier_cost_cents IS NOT NULL;

COMMIT;

-- Verification snapshot (run after commit):
--   SELECT
--     count(*) total,
--     count(*) FILTER (WHERE supplier_cost_cents IS NULL)  null_cost,
--     count(*) FILTER (WHERE shipping_cost_cents IS NULL)  null_ship,
--     count(*) FILTER (WHERE price_cents < supplier_cost_cents + shipping_cost_cents) underpriced,
--     avg(price_cents)::int avg_price,
--     avg(supplier_cost_cents)::int avg_cost,
--     round(avg(price_cents::numeric / NULLIF(supplier_cost_cents+shipping_cost_cents,0))::numeric, 2) avg_multiplier
--   FROM marketplace_products WHERE supplier='aliexpress';
