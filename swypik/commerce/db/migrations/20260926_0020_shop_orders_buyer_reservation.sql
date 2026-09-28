-- 20260926_0020_shop_orders_buyer_reservation
--
-- Magazin (cumpărător), audit shop 2026-09-25 — P0:
--  1. `commerce_orders.reserved_until`: o comandă neplătită ține stocul rezervat
--     până la acest moment (lib/shop/checkout.ts). NULL = nu rezervă nimic.
--  2. `cart_items.video_id`: clipul din care a fost adăugat produsul — atribuirea
--     comisionului către creatorul corect (înainte se pierdea, câștiga „primul
--     clip fixat”).
--  3. Backfill `buyer_user_id`: nicio comandă nu îl avea (checkout-ul nu îl
--     scria), deci istoricul, recenziile verificate și retururile erau moarte.
--     Legăm comenzile existente de contul cu același email (case-insensitive),
--     doar dacă emailul identifică un singur utilizator.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, backfill
-- doar pe rândurile cu buyer_user_id NULL. Fără DROP/DELETE.
-- Reversare: ALTER TABLE ... DROP COLUMN reserved_until / video_id (după backup);
-- backfill-ul e marcat în metadata.buyer_backfilled_at pentru identificare.

ALTER TABLE commerce_orders ADD COLUMN IF NOT EXISTS reserved_until timestamptz;

CREATE INDEX IF NOT EXISTS commerce_orders_pending_reserved_idx
  ON commerce_orders (reserved_until)
  WHERE status = 'pending' AND reserved_until IS NOT NULL;

ALTER TABLE cart_items ADD COLUMN IF NOT EXISTS video_id uuid;

WITH unique_users AS (
  SELECT lower(email) AS email_lower, (array_agg(id))[1] AS user_id
    FROM users
   WHERE email IS NOT NULL AND email <> ''
   GROUP BY lower(email)
  HAVING COUNT(*) = 1
)
UPDATE commerce_orders o
   SET buyer_user_id = uu.user_id,
       metadata = o.metadata || jsonb_build_object('buyer_backfilled_at', now()::text)
  FROM unique_users uu
 WHERE o.buyer_user_id IS NULL
   AND NULLIF(o.metadata->>'customer_email', '') IS NOT NULL
   AND lower(o.metadata->>'customer_email') = uu.email_lower;
