BEGIN;

CREATE TABLE IF NOT EXISTS sellers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text,
  email text NOT NULL UNIQUE,
  cui text,
  phone text,
  product_type text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'active', 'suspended', 'rejected')),
  stripe_account_id text,
  business_details jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE sellers
  ADD COLUMN IF NOT EXISTS name text,
  ADD COLUMN IF NOT EXISTS cui text,
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS product_type text,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS stripe_account_id text,
  ADD COLUMN IF NOT EXISTS business_details jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS seller_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id uuid NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS seller_sessions_token_expires_idx
  ON seller_sessions (token, expires_at);

CREATE INDEX IF NOT EXISTS sellers_status_created_at_idx
  ON sellers (status, created_at DESC);

ALTER TABLE marketplace_products
  ADD COLUMN IF NOT EXISTS seller_id uuid REFERENCES sellers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS marketplace_products_seller_idx
  ON marketplace_products (seller_id, status, created_at DESC)
  WHERE seller_id IS NOT NULL;

ALTER TABLE commerce_order_items
  ADD COLUMN IF NOT EXISTS source_status text NOT NULL DEFAULT 'pending'
    CHECK (source_status IN ('pending', 'pending_seller_action', 'pending_dropship', 'processing_dropship', 'fulfilled', 'cancelled', 'failed'));

CREATE INDEX IF NOT EXISTS commerce_order_items_seller_status_idx
  ON commerce_order_items ((metadata->>'seller_id'), source_status)
  WHERE metadata ? 'seller_id';

CREATE TABLE IF NOT EXISTS creators (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  social_link text NOT NULL,
  followers text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'active', 'suspended', 'rejected')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS creator_videos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id text NOT NULL,
  product_id text NOT NULL,
  video_url text,
  description text,
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'ready', 'failed', 'archived')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS creator_videos_creator_created_at_idx
  ON creator_videos (creator_id, created_at DESC);

COMMIT;
