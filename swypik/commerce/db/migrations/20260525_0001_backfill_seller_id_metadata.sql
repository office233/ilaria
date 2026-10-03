-- Backfill metadata.seller_id pentru items care nu au, din marketplace_products.seller_id
-- Rulează idempotent — re-run safe (doar items fără seller_id în metadata).
-- Items vechi (înainte ca checkout flow să propage seller_id) rămâneau orfane → dashboard seller gol.

WITH items_to_fix AS (
  SELECT coi.id, p.seller_id
  FROM commerce_order_items coi
  JOIN marketplace_products p
    ON (
      p.id = (coi.metadata->>'pg_id')::uuid
      OR p.id = (coi.metadata->>'product_id')::uuid
      OR p.id = coi.product_id
    )
  WHERE (coi.metadata->>'seller_id' IS NULL OR coi.metadata->>'seller_id' = '')
    AND p.seller_id IS NOT NULL
)
UPDATE commerce_order_items coi
SET metadata = coi.metadata || jsonb_build_object('seller_id', f.seller_id::text, 'seller_id_backfilled_at', now()::text)
FROM items_to_fix f
WHERE coi.id = f.id;
