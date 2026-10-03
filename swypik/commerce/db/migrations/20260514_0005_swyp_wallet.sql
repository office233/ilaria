-- 20260514_0005_swyp_wallet.sql
-- Extinde swyp_wallets pentru daily claim + creează saved_products.

BEGIN;

ALTER TABLE swyp_wallets
  ADD COLUMN IF NOT EXISTS daily_claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS daily_streak integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS saved_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES marketplace_products(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, product_id)
);

CREATE INDEX IF NOT EXISTS saved_products_user_created_idx
  ON saved_products (user_id, created_at DESC);

COMMIT;
