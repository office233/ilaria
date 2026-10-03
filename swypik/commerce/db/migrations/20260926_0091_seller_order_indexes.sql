-- 20260926_0091_seller_order_indexes
--
-- Panoul seller-ului (comenzi, dashboard, sold, retrageri) filtrează
-- commerce_order_items după metadata->>'seller_id' și, la retrageri, după
-- metadata->>'seller_payout_request_id'. Fără index, fiecare pagină făcea
-- seq-scan pe toate item-urile. Idempotent, doar indexuri.

CREATE INDEX IF NOT EXISTS idx_coi_seller_id
  ON commerce_order_items ((metadata->>'seller_id'), created_at DESC)
  WHERE metadata ? 'seller_id';

CREATE INDEX IF NOT EXISTS idx_coi_seller_payout_request
  ON commerce_order_items ((metadata->>'seller_payout_request_id'))
  WHERE metadata ? 'seller_payout_request_id';

CREATE INDEX IF NOT EXISTS idx_marketplace_products_seller
  ON marketplace_products (seller_id, updated_at DESC)
  WHERE seller_id IS NOT NULL;
