-- 20260730_0017_product_social.sql
-- Like & share pe produse marketplace (home feed social).
BEGIN;

ALTER TABLE likes ADD COLUMN IF NOT EXISTS product_id uuid REFERENCES marketplace_products(id) ON DELETE CASCADE;
ALTER TABLE shares ADD COLUMN IF NOT EXISTS product_id uuid REFERENCES marketplace_products(id) ON DELETE CASCADE;

-- shares avea video_id NOT NULL; acum acceptam si share pe produs
ALTER TABLE shares ALTER COLUMN video_id DROP NOT NULL;
ALTER TABLE shares DROP CONSTRAINT IF EXISTS shares_single_target_check;
ALTER TABLE shares ADD CONSTRAINT shares_single_target_check CHECK (
  (CASE WHEN video_id IS NOT NULL THEN 1 ELSE 0 END
 + CASE WHEN product_id IS NOT NULL THEN 1 ELSE 0 END) = 1
);

-- Exact un target per like (video XOR comment XOR product)
ALTER TABLE likes DROP CONSTRAINT IF EXISTS likes_video_id_comment_id_check;
ALTER TABLE likes DROP CONSTRAINT IF EXISTS likes_check;
ALTER TABLE likes DROP CONSTRAINT IF EXISTS likes_single_target_check;
ALTER TABLE likes ADD CONSTRAINT likes_single_target_check CHECK (
  (CASE WHEN video_id IS NOT NULL THEN 1 ELSE 0 END
 + CASE WHEN comment_id IS NOT NULL THEN 1 ELSE 0 END
 + CASE WHEN product_id IS NOT NULL THEN 1 ELSE 0 END) = 1
);

CREATE UNIQUE INDEX IF NOT EXISTS likes_user_product_uidx
  ON likes (user_id, product_id) WHERE product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS shares_product_idx
  ON shares (product_id) WHERE product_id IS NOT NULL;

-- Contoare denormalizate pentru feed
CREATE TABLE IF NOT EXISTS product_stats (
  product_id uuid PRIMARY KEY REFERENCES marketplace_products(id) ON DELETE CASCADE,
  like_count integer NOT NULL DEFAULT 0,
  share_count integer NOT NULL DEFAULT 0,
  comment_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
