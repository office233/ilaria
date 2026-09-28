-- Clean AliExpress catalog schema for reimported dropshipping products.

BEGIN;

ALTER TABLE marketplace_products
  ADD COLUMN IF NOT EXISTS canonical_category text,
  ADD COLUMN IF NOT EXISTS canonical_category_slug text,
  ADD COLUMN IF NOT EXISTS classification_confidence numeric(4,3),
  ADD COLUMN IF NOT EXISTS classification_reason text,
  ADD COLUMN IF NOT EXISTS taxonomy_department text,
  ADD COLUMN IF NOT EXISTS taxonomy_category text,
  ADD COLUMN IF NOT EXISTS taxonomy_subcategory text,
  ADD COLUMN IF NOT EXISTS taxonomy_leaf text,
  ADD COLUMN IF NOT EXISTS taxonomy_slug text,
  ADD COLUMN IF NOT EXISTS taxonomy_confidence numeric(4,3),
  ADD COLUMN IF NOT EXISTS taxonomy_reason text;

CREATE INDEX IF NOT EXISTS idx_mp_taxonomy_slug_active_non_adult
  ON marketplace_products (taxonomy_slug, updated_at DESC)
  WHERE status = 'active' AND is_adult = false;

CREATE INDEX IF NOT EXISTS idx_mp_supplier_product
  ON marketplace_products (supplier, supplier_product_id)
  WHERE supplier_product_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_mpv_product_status_stock
  ON marketplace_product_variants (product_id, status, inventory_quantity DESC);

CREATE INDEX IF NOT EXISTS idx_mpv_ae_sku_id
  ON marketplace_product_variants ((metadata->>'ae_sku_id'))
  WHERE metadata ? 'ae_sku_id';

DROP INDEX IF EXISTS marketplace_product_variants_ae_required_uidx;
CREATE UNIQUE INDEX marketplace_product_variants_ae_required_uidx
  ON marketplace_product_variants (product_id, (metadata->>'ae_sku_id'))
  WHERE metadata ? 'ae_sku_id';

ALTER TABLE marketplace_product_variants
  DROP CONSTRAINT IF EXISTS marketplace_product_variants_ae_metadata_required,
  ADD CONSTRAINT marketplace_product_variants_ae_metadata_required
  CHECK (
    metadata->>'source' IS DISTINCT FROM 'official_ae_api'
    OR (
      nullif(metadata->>'ae_product_id', '') IS NOT NULL
      AND nullif(metadata->>'ae_sku_id', '') IS NOT NULL
      AND nullif(metadata->>'ae_sku_attr', '') IS NOT NULL
    )
  );

INSERT INTO schema_migrations (version, applied_at)
VALUES ('20260515_0015_clean_aliexpress_catalog_schema', now())
ON CONFLICT (version) DO NOTHING;

COMMIT;
