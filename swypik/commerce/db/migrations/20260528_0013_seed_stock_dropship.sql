-- Backfill metadata.available_stock pentru produsele AE dropship care n-au stock.
-- Pentru dropshipping, stock-ul e teoretic infinit; folosim 999 ca sentinel.
-- Idempotent: UPDATE doar dacă metadata.available_stock e absent sau 0.
BEGIN;

UPDATE marketplace_products
SET metadata = jsonb_set(metadata, '{available_stock}', to_jsonb(999), true),
    updated_at = now()
WHERE status = 'active'
  AND supplier = 'aliexpress'
  AND COALESCE((metadata->>'available_stock')::int, 0) = 0;

-- Pentru variantele importate fără inventory_quantity (NULL), seed 999 ca să nu blocăm checkout.
UPDATE marketplace_product_variants v
SET inventory_quantity = 999,
    updated_at = now()
FROM marketplace_products p
WHERE v.product_id = p.id
  AND p.supplier = 'aliexpress'
  AND p.status = 'active'
  AND v.inventory_quantity IS NULL;

COMMIT;
