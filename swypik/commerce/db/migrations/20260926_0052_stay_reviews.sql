-- 20260926_0052_stay_reviews
--
-- Recenzii după sejur (audit stays.md §3: „Reviews: none”).
-- O singură recenzie per rezervare, doar de la clientul rezervării, doar după
-- check-out (verificat în lib/stays/reviews.ts). Gazda poate răspunde o dată.
-- Idempotent.

CREATE TABLE IF NOT EXISTS stay_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL UNIQUE REFERENCES stay_bookings(id),
  product_id uuid NOT NULL REFERENCES marketplace_products(id),
  guest_user_id uuid NOT NULL,
  host_user_id uuid,
  rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment text CHECK (comment IS NULL OR char_length(comment) <= 2000),
  host_reply text CHECK (host_reply IS NULL OR char_length(host_reply) <= 1000),
  status text NOT NULL DEFAULT 'published' CHECK (status IN ('published','hidden')),
  created_at timestamptz NOT NULL DEFAULT now(),
  replied_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_stay_reviews_product
  ON stay_reviews (product_id, created_at DESC) WHERE status = 'published';
CREATE INDEX IF NOT EXISTS idx_stay_reviews_host ON stay_reviews (host_user_id);
