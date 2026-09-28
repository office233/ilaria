-- ============================================================================
-- ERP Connect — coloanele și tabela de mapare pe care codul din
-- app/api/seller/erp/* le folosește dar nu existau în DB.
-- Idempotent.
-- ============================================================================

ALTER TABLE sellers ADD COLUMN IF NOT EXISTS erp_api_url text;
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS erp_api_key text;
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS erp_connected boolean NOT NULL DEFAULT false;
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS erp_last_sync timestamptz;

CREATE TABLE IF NOT EXISTS erp_product_mapping (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id uuid NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  erp_product_id text NOT NULL,
  erp_sku text,
  marketplace_product_id uuid REFERENCES marketplace_products(id) ON DELETE SET NULL,
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (seller_id, erp_product_id)
);
CREATE INDEX IF NOT EXISTS idx_epm_seller ON erp_product_mapping (seller_id);
CREATE INDEX IF NOT EXISTS idx_epm_mp ON erp_product_mapping (marketplace_product_id)
  WHERE marketplace_product_id IS NOT NULL;
