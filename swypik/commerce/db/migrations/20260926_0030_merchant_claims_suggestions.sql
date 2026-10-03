-- 20260926_0030_merchant_claims_suggestions
--
-- Swypik Food — profilurile nerevendicate (listing_mode = 'suggest_only'):
--   * „Sugerează proprietarului": clienții semnalează că vor restaurantul pe
--     Swypik. Un vot per (restaurant, user/IP) — merchant_suggestions — și un
--     contor denormalizat local_merchants.suggestion_count pentru listare.
--   * „Revendică afacerea": merchant_claim_requests (creată în
--     20260804_0001, nefolosită până acum) primește câmpurile de review și
--     legătura cu sellerul creat/legat la aprobare.
-- Idempotent; nu șterge nimic.

BEGIN;

ALTER TABLE local_merchants
  ADD COLUMN IF NOT EXISTS suggestion_count integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS merchant_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES local_merchants(id) ON DELETE CASCADE,
  -- sha256('u:'+user_id) sau sha256('ip:'+ip) — niciodată IP-ul în clar
  suggester_key text NOT NULL,
  user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, suggester_key)
);
CREATE INDEX IF NOT EXISTS merchant_suggestions_merchant_idx
  ON merchant_suggestions (merchant_id, created_at DESC);

ALTER TABLE merchant_claim_requests
  ADD COLUMN IF NOT EXISTS review_note text,
  ADD COLUMN IF NOT EXISTS seller_id uuid,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- O singură cerere în așteptare per (restaurant, user).
CREATE UNIQUE INDEX IF NOT EXISTS merchant_claim_requests_pending_uniq
  ON merchant_claim_requests (merchant_id, user_id)
  WHERE status = 'pending';

COMMIT;
