-- ──────────────────────────────────────────────────────────────────────────────
-- Migration: Meister ERP Connect (2026-07-22)
-- Fiecare seller poate conecta propriul ERP pentru:
--   1. Import catalog produse direct din ERP
--   2. Fulfillment automat (comenzile Swypik → ERP → expediere)
--   3. Stoc in timp real
-- ──────────────────────────────────────────────────────────────────────────────

ALTER TABLE sellers
    ADD COLUMN IF NOT EXISTS erp_api_url   TEXT,    -- ex: https://erp.firmamea.ro
    ADD COLUMN IF NOT EXISTS erp_api_key   TEXT,    -- msk_xxx (stocat encrypted)
    ADD COLUMN IF NOT EXISTS erp_connected BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS erp_last_sync TIMESTAMPTZ;

-- Log sync produse ERP → Swypik
CREATE TABLE IF NOT EXISTS erp_sync_log (
    id          BIGSERIAL PRIMARY KEY,
    seller_id   UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
    synced_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    products_imported INT NOT NULL DEFAULT 0,
    products_updated  INT NOT NULL DEFAULT 0,
    status      TEXT NOT NULL DEFAULT 'ok', -- ok | error
    error_msg   TEXT
);

CREATE INDEX IF NOT EXISTS idx_erp_sync_seller ON erp_sync_log(seller_id, synced_at DESC);

-- Mapare produs ERP → produs Swypik (pentru fulfillment)
CREATE TABLE IF NOT EXISTS erp_product_mapping (
    id                   BIGSERIAL PRIMARY KEY,
    seller_id            UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
    erp_product_id       TEXT NOT NULL,       -- id produs din ERP
    erp_sku              TEXT,
    marketplace_product_id TEXT REFERENCES marketplace_products(id) ON DELETE SET NULL,
    last_synced_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(seller_id, erp_product_id)
);
