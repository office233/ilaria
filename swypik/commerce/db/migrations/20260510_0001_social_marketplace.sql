BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION social_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_auth_id text,
  username text NOT NULL,
  display_name text,
  email text,
  avatar_url text,
  bio text,
  locale text NOT NULL DEFAULT 'en',
  role text NOT NULL DEFAULT 'shopper' CHECK (role IN ('shopper', 'creator', 'moderator', 'admin')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invited', 'suspended', 'deleted')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_external_auth_id_uidx
  ON users (external_auth_id)
  WHERE external_auth_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_uidx
  ON users (lower(username));
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_uidx
  ON users (lower(email))
  WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS users_status_created_at_idx
  ON users (status, created_at DESC);

CREATE TABLE IF NOT EXISTS creator_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  handle text NOT NULL,
  display_name text,
  bio text,
  avatar_url text,
  banner_url text,
  category text,
  website_url text,
  social_links jsonb NOT NULL DEFAULT '{}'::jsonb,
  verification_status text NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('unverified', 'pending', 'verified', 'rejected')),
  payout_status text NOT NULL DEFAULT 'not_connected' CHECK (payout_status IN ('not_connected', 'pending', 'connected', 'restricted')),
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS creator_profiles_handle_lower_uidx
  ON creator_profiles (lower(handle));
CREATE INDEX IF NOT EXISTS creator_profiles_verification_status_idx
  ON creator_profiles (verification_status, created_at DESC);

CREATE TABLE IF NOT EXISTS videos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  creator_profile_id uuid REFERENCES creator_profiles(id) ON DELETE SET NULL,
  slug text,
  title text NOT NULL,
  description text,
  thumbnail_url text,
  playback_url text,
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  width integer CHECK (width IS NULL OR width > 0),
  height integer CHECK (height IS NULL OR height > 0),
  visibility text NOT NULL DEFAULT 'draft' CHECK (visibility IN ('draft', 'unlisted', 'public', 'private')),
  status text NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading', 'processing', 'ready', 'failed', 'archived', 'deleted')),
  language_code text NOT NULL DEFAULT 'en',
  product_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  tags text[] NOT NULL DEFAULT ARRAY[]::text[],
  view_count bigint NOT NULL DEFAULT 0 CHECK (view_count >= 0),
  like_count bigint NOT NULL DEFAULT 0 CHECK (like_count >= 0),
  comment_count bigint NOT NULL DEFAULT 0 CHECK (comment_count >= 0),
  save_count bigint NOT NULL DEFAULT 0 CHECK (save_count >= 0),
  share_count bigint NOT NULL DEFAULT 0 CHECK (share_count >= 0),
  published_at timestamptz,
  archived_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  search_document tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(description, '')), 'B')
  ) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS videos_slug_uidx
  ON videos (slug)
  WHERE slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS videos_creator_created_at_idx
  ON videos (creator_id, created_at DESC);
CREATE INDEX IF NOT EXISTS videos_public_feed_idx
  ON videos (published_at DESC, id)
  WHERE visibility = 'public' AND status = 'ready';
CREATE INDEX IF NOT EXISTS videos_status_idx
  ON videos (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS videos_tags_gin_idx
  ON videos USING gin (tags);
CREATE INDEX IF NOT EXISTS videos_product_refs_gin_idx
  ON videos USING gin (product_refs jsonb_path_ops);
CREATE INDEX IF NOT EXISTS videos_search_document_gin_idx
  ON videos USING gin (search_document);

CREATE TABLE IF NOT EXISTS video_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  asset_type text NOT NULL CHECK (asset_type IN ('source', 'transcoded', 'thumbnail', 'caption', 'preview', 'metadata')),
  storage_provider text NOT NULL DEFAULT 'r2' CHECK (storage_provider IN ('r2', 's3', 'minio', 'local')),
  bucket text NOT NULL,
  object_key text NOT NULL,
  public_url text,
  mime_type text,
  byte_size bigint CHECK (byte_size IS NULL OR byte_size >= 0),
  checksum_sha256 text,
  width integer CHECK (width IS NULL OR width > 0),
  height integer CHECK (height IS NULL OR height > 0),
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'uploading', 'available', 'failed', 'deleted')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (storage_provider, bucket, object_key)
);

CREATE INDEX IF NOT EXISTS video_assets_video_type_idx
  ON video_assets (video_id, asset_type, created_at DESC);
CREATE INDEX IF NOT EXISTS video_assets_status_idx
  ON video_assets (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  parent_comment_id uuid REFERENCES comments(id) ON DELETE CASCADE,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'hidden', 'deleted', 'flagged')),
  like_count bigint NOT NULL DEFAULT 0 CHECK (like_count >= 0),
  reply_count bigint NOT NULL DEFAULT 0 CHECK (reply_count >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS comments_video_created_at_idx
  ON comments (video_id, created_at DESC);
CREATE INDEX IF NOT EXISTS comments_parent_created_at_idx
  ON comments (parent_comment_id, created_at)
  WHERE parent_comment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS comments_user_created_at_idx
  ON comments (user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS likes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id uuid REFERENCES videos(id) ON DELETE CASCADE,
  comment_id uuid REFERENCES comments(id) ON DELETE CASCADE,
  reaction text NOT NULL DEFAULT 'like',
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (video_id IS NOT NULL AND comment_id IS NULL) OR
    (video_id IS NULL AND comment_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS likes_user_video_uidx
  ON likes (user_id, video_id)
  WHERE video_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS likes_user_comment_uidx
  ON likes (user_id, comment_id)
  WHERE comment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS likes_video_created_at_idx
  ON likes (video_id, created_at DESC)
  WHERE video_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS likes_comment_created_at_idx
  ON likes (comment_id, created_at DESC)
  WHERE comment_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS follows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  follower_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  following_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_level text NOT NULL DEFAULT 'highlights' CHECK (notification_level IN ('none', 'highlights', 'all')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (follower_user_id <> following_user_id),
  UNIQUE (follower_user_id, following_user_id)
);

CREATE INDEX IF NOT EXISTS follows_following_created_at_idx
  ON follows (following_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS follows_follower_created_at_idx
  ON follows (follower_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS saves (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  collection_name text NOT NULL DEFAULT 'default',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, video_id, collection_name)
);

CREATE INDEX IF NOT EXISTS saves_user_created_at_idx
  ON saves (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS saves_video_created_at_idx
  ON saves (video_id, created_at DESC);

CREATE TABLE IF NOT EXISTS shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('copy_link', 'native_share', 'email', 'sms', 'whatsapp', 'facebook', 'instagram', 'tiktok', 'x', 'other')),
  share_token text,
  destination_url text,
  referrer_url text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS shares_share_token_uidx
  ON shares (share_token)
  WHERE share_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS shares_video_created_at_idx
  ON shares (video_id, created_at DESC);
CREATE INDEX IF NOT EXISTS shares_user_created_at_idx
  ON shares (user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS feed_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  video_id uuid REFERENCES videos(id) ON DELETE CASCADE,
  comment_id uuid REFERENCES comments(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('video_published', 'video_viewed', 'video_liked', 'video_saved', 'video_shared', 'comment_created', 'creator_followed')),
  audience text NOT NULL DEFAULT 'global' CHECK (audience IN ('global', 'followers', 'personalized')),
  score numeric(10, 4) NOT NULL DEFAULT 0,
  source text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  CHECK (expires_at IS NULL OR expires_at > occurred_at)
);

CREATE INDEX IF NOT EXISTS feed_events_global_idx
  ON feed_events (audience, score DESC, occurred_at DESC);
CREATE INDEX IF NOT EXISTS feed_events_expires_at_idx
  ON feed_events (expires_at)
  WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS feed_events_actor_idx
  ON feed_events (actor_user_id, occurred_at DESC)
  WHERE actor_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS feed_events_video_idx
  ON feed_events (video_id, occurred_at DESC)
  WHERE video_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS feed_events_type_occurred_at_idx
  ON feed_events (event_type, occurred_at DESC);

CREATE TABLE IF NOT EXISTS creator_collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  slug text,
  visibility text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'unlisted', 'private')),
  sort_order integer NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS creator_collections_creator_slug_uidx
  ON creator_collections (creator_id, slug)
  WHERE slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS creator_collections_creator_sort_idx
  ON creator_collections (creator_id, sort_order, created_at DESC);

CREATE TABLE IF NOT EXISTS creator_collection_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id uuid NOT NULL REFERENCES creator_collections(id) ON DELETE CASCADE,
  video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  sort_order integer NOT NULL DEFAULT 0,
  note text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (collection_id, video_id)
);

CREATE INDEX IF NOT EXISTS creator_collection_items_collection_sort_idx
  ON creator_collection_items (collection_id, sort_order, created_at DESC);
CREATE INDEX IF NOT EXISTS creator_collection_items_video_idx
  ON creator_collection_items (video_id);

CREATE TABLE IF NOT EXISTS commissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  buyer_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  video_id uuid REFERENCES videos(id) ON DELETE SET NULL,
  source_share_id uuid REFERENCES shares(id) ON DELETE SET NULL,
  external_order_id text,
  external_line_item_id text,
  commission_type text NOT NULL DEFAULT 'affiliate' CHECK (commission_type IN ('affiliate', 'sponsored', 'manual_adjustment')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'payable', 'paid', 'void', 'refunded')),
  currency char(3) NOT NULL DEFAULT 'USD',
  gross_amount_cents integer NOT NULL DEFAULT 0 CHECK (gross_amount_cents >= 0),
  creator_amount_cents integer NOT NULL DEFAULT 0 CHECK (creator_amount_cents >= 0),
  platform_fee_cents integer NOT NULL DEFAULT 0 CHECK (platform_fee_cents >= 0),
  approved_at timestamptz,
  payable_at timestamptz,
  paid_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS commissions_creator_status_idx
  ON commissions (creator_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS commissions_external_order_idx
  ON commissions (external_order_id)
  WHERE external_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS commissions_video_idx
  ON commissions (video_id, created_at DESC)
  WHERE video_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  video_id uuid REFERENCES videos(id) ON DELETE SET NULL,
  comment_id uuid REFERENCES comments(id) ON DELETE SET NULL,
  notification_type text NOT NULL CHECK (notification_type IN ('follow', 'like', 'comment', 'reply', 'share', 'commission', 'system', 'upload_processed')),
  title text NOT NULL,
  body text,
  action_url text,
  delivery_status text NOT NULL DEFAULT 'queued' CHECK (delivery_status IN ('queued', 'sent', 'failed', 'suppressed')),
  read_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notifications_user_unread_idx
  ON notifications (user_id, created_at DESC)
  WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS notifications_user_created_at_idx
  ON notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_type_created_at_idx
  ON notifications (notification_type, created_at DESC);

CREATE TABLE IF NOT EXISTS video_upload_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id uuid REFERENCES videos(id) ON DELETE SET NULL,
  storage_provider text NOT NULL DEFAULT 'r2' CHECK (storage_provider IN ('r2', 's3', 'minio', 'local')),
  bucket text NOT NULL,
  object_key text NOT NULL,
  upload_id text,
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'uploading', 'completed', 'aborted', 'expired')),
  byte_size bigint CHECK (byte_size IS NULL OR byte_size >= 0),
  content_type text,
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS video_upload_sessions_user_created_at_idx
  ON video_upload_sessions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS video_upload_sessions_video_idx
  ON video_upload_sessions (video_id)
  WHERE video_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS video_upload_sessions_status_expires_idx
  ON video_upload_sessions (status, expires_at);

CREATE TABLE IF NOT EXISTS video_processing_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  asset_id uuid REFERENCES video_assets(id) ON DELETE SET NULL,
  job_type text NOT NULL CHECK (job_type IN ('probe', 'transcode', 'thumbnail', 'caption', 'moderation', 'publish')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  priority integer NOT NULL DEFAULT 100,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  scheduled_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  error_code text,
  error_message text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS video_processing_jobs_queue_idx
  ON video_processing_jobs (status, priority, scheduled_at)
  WHERE status IN ('queued', 'failed');
CREATE INDEX IF NOT EXISTS video_processing_jobs_video_idx
  ON video_processing_jobs (video_id, created_at DESC);
CREATE INDEX IF NOT EXISTS video_processing_jobs_asset_idx
  ON video_processing_jobs (asset_id)
  WHERE asset_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS auth_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('email', 'google', 'apple', 'facebook', 'tiktok', 'github', 'stripe', 'shopify', 'other')),
  provider_subject text NOT NULL,
  email text,
  email_verified boolean NOT NULL DEFAULT false,
  access_token_ref text,
  refresh_token_ref text,
  linked_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_subject)
);

CREATE INDEX IF NOT EXISTS auth_accounts_user_idx
  ON auth_accounts (user_id, provider);
CREATE INDEX IF NOT EXISTS auth_accounts_email_lower_idx
  ON auth_accounts (lower(email))
  WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS user_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_token_hash text NOT NULL,
  device_fingerprint text,
  ip_address inet,
  user_agent text,
  last_seen_at timestamptz,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_token_hash),
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS user_sessions_user_active_idx
  ON user_sessions (user_id, expires_at DESC)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS user_sessions_expires_at_idx
  ON user_sessions (expires_at);

CREATE TABLE IF NOT EXISTS service_api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  name text NOT NULL,
  key_hash text NOT NULL,
  scopes text[] NOT NULL DEFAULT ARRAY[]::text[],
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'expired')),
  last_used_at timestamptz,
  expires_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (key_hash)
);

CREATE INDEX IF NOT EXISTS service_api_keys_owner_idx
  ON service_api_keys (owner_user_id, created_at DESC)
  WHERE owner_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS service_api_keys_scopes_gin_idx
  ON service_api_keys USING gin (scopes);

CREATE TABLE IF NOT EXISTS creator_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requested_handle text NOT NULL,
  category text,
  website_url text,
  social_links jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'in_review', 'approved', 'rejected', 'withdrawn')),
  reviewer_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  review_note text,
  reviewed_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS creator_applications_user_idx
  ON creator_applications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS creator_applications_status_idx
  ON creator_applications (status, created_at DESC);

CREATE TABLE IF NOT EXISTS marketplace_merchants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  name text NOT NULL,
  external_ref text,
  website_url text,
  support_email text,
  default_currency char(3) NOT NULL DEFAULT 'USD',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'disabled')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS marketplace_merchants_external_ref_uidx
  ON marketplace_merchants (external_ref)
  WHERE external_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS marketplace_merchants_owner_idx
  ON marketplace_merchants (owner_user_id, created_at DESC)
  WHERE owner_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS marketplace_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid REFERENCES marketplace_merchants(id) ON DELETE SET NULL,
  external_product_id text,
  slug text,
  title text NOT NULL,
  description text,
  brand text,
  category text,
  product_url text,
  image_url text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'out_of_stock', 'archived', 'disabled')),
  currency char(3) NOT NULL DEFAULT 'USD',
  price_cents integer CHECK (price_cents IS NULL OR price_cents >= 0),
  compare_at_price_cents integer CHECK (compare_at_price_cents IS NULL OR compare_at_price_cents >= 0),
  inventory_status text NOT NULL DEFAULT 'unknown' CHECK (inventory_status IN ('unknown', 'in_stock', 'low_stock', 'out_of_stock', 'preorder')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  search_document tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(brand, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(category, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(description, '')), 'C')
  ) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS marketplace_products_merchant_external_uidx
  ON marketplace_products (merchant_id, external_product_id)
  WHERE merchant_id IS NOT NULL AND external_product_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS marketplace_products_slug_uidx
  ON marketplace_products (slug)
  WHERE slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS marketplace_products_status_idx
  ON marketplace_products (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS marketplace_products_search_document_gin_idx
  ON marketplace_products USING gin (search_document);

CREATE TABLE IF NOT EXISTS marketplace_product_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES marketplace_products(id) ON DELETE CASCADE,
  external_variant_id text,
  sku text,
  title text,
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  currency char(3) NOT NULL DEFAULT 'USD',
  price_cents integer CHECK (price_cents IS NULL OR price_cents >= 0),
  inventory_quantity integer CHECK (inventory_quantity IS NULL OR inventory_quantity >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'out_of_stock', 'archived', 'disabled')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS marketplace_product_variants_external_uidx
  ON marketplace_product_variants (product_id, external_variant_id)
  WHERE external_variant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS marketplace_product_variants_product_idx
  ON marketplace_product_variants (product_id, status);

CREATE TABLE IF NOT EXISTS marketplace_product_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES marketplace_products(id) ON DELETE CASCADE,
  merchant_id uuid REFERENCES marketplace_merchants(id) ON DELETE SET NULL,
  offer_url text NOT NULL,
  source text NOT NULL DEFAULT 'direct' CHECK (source IN ('direct', 'affiliate', 'shopify', 'manual', 'other')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'expired', 'disabled')),
  currency char(3) NOT NULL DEFAULT 'USD',
  price_cents integer CHECK (price_cents IS NULL OR price_cents >= 0),
  commission_rate_bps integer CHECK (commission_rate_bps IS NULL OR commission_rate_bps BETWEEN 0 AND 10000),
  starts_at timestamptz,
  ends_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS marketplace_product_offers_product_idx
  ON marketplace_product_offers (product_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS marketplace_product_offers_merchant_idx
  ON marketplace_product_offers (merchant_id, status)
  WHERE merchant_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS creator_product_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES marketplace_products(id) ON DELETE CASCADE,
  offer_id uuid REFERENCES marketplace_product_offers(id) ON DELETE SET NULL,
  tracking_code text,
  affiliate_url text,
  utm_source text,
  commission_rate_bps integer CHECK (commission_rate_bps IS NULL OR commission_rate_bps BETWEEN 0 AND 10000),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'disabled')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS creator_product_links_tracking_code_uidx
  ON creator_product_links (tracking_code)
  WHERE tracking_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS creator_product_links_creator_idx
  ON creator_product_links (creator_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS creator_product_links_product_idx
  ON creator_product_links (product_id, status);

CREATE TABLE IF NOT EXISTS video_product_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES marketplace_products(id) ON DELETE CASCADE,
  creator_product_link_id uuid REFERENCES creator_product_links(id) ON DELETE SET NULL,
  placement text NOT NULL DEFAULT 'tagged' CHECK (placement IN ('tagged', 'pinned', 'chapter', 'overlay', 'description')),
  start_ms integer CHECK (start_ms IS NULL OR start_ms >= 0),
  end_ms integer CHECK (end_ms IS NULL OR end_ms >= 0),
  sort_order integer NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_ms IS NULL OR start_ms IS NULL OR end_ms >= start_ms)
);

CREATE UNIQUE INDEX IF NOT EXISTS video_product_links_video_product_placement_uidx
  ON video_product_links (video_id, product_id, placement, sort_order);
CREATE INDEX IF NOT EXISTS video_product_links_video_sort_idx
  ON video_product_links (video_id, sort_order, created_at DESC);
CREATE INDEX IF NOT EXISTS video_product_links_product_idx
  ON video_product_links (product_id, created_at DESC);

CREATE TABLE IF NOT EXISTS commerce_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  merchant_id uuid REFERENCES marketplace_merchants(id) ON DELETE SET NULL,
  source_share_id uuid REFERENCES shares(id) ON DELETE SET NULL,
  external_order_id text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'authorized', 'paid', 'fulfilled', 'cancelled', 'refunded', 'failed')),
  currency char(3) NOT NULL DEFAULT 'USD',
  subtotal_cents integer NOT NULL DEFAULT 0 CHECK (subtotal_cents >= 0),
  discount_cents integer NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  shipping_cents integer NOT NULL DEFAULT 0 CHECK (shipping_cents >= 0),
  tax_cents integer NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  total_cents integer NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  placed_at timestamptz,
  fulfilled_at timestamptz,
  cancelled_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS commerce_orders_external_uidx
  ON commerce_orders (merchant_id, external_order_id)
  WHERE merchant_id IS NOT NULL AND external_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS commerce_orders_buyer_created_at_idx
  ON commerce_orders (buyer_user_id, created_at DESC)
  WHERE buyer_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS commerce_orders_status_idx
  ON commerce_orders (status, created_at DESC);

CREATE TABLE IF NOT EXISTS commerce_order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES commerce_orders(id) ON DELETE CASCADE,
  product_id uuid REFERENCES marketplace_products(id) ON DELETE SET NULL,
  variant_id uuid REFERENCES marketplace_product_variants(id) ON DELETE SET NULL,
  creator_id uuid REFERENCES users(id) ON DELETE SET NULL,
  video_id uuid REFERENCES videos(id) ON DELETE SET NULL,
  creator_product_link_id uuid REFERENCES creator_product_links(id) ON DELETE SET NULL,
  external_line_item_id text,
  title text NOT NULL,
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  currency char(3) NOT NULL DEFAULT 'USD',
  unit_amount_cents integer NOT NULL DEFAULT 0 CHECK (unit_amount_cents >= 0),
  gross_amount_cents integer NOT NULL DEFAULT 0 CHECK (gross_amount_cents >= 0),
  commissionable_amount_cents integer NOT NULL DEFAULT 0 CHECK (commissionable_amount_cents >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS commerce_order_items_external_uidx
  ON commerce_order_items (order_id, external_line_item_id)
  WHERE external_line_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS commerce_order_items_order_idx
  ON commerce_order_items (order_id, created_at);
CREATE INDEX IF NOT EXISTS commerce_order_items_creator_idx
  ON commerce_order_items (creator_id, created_at DESC)
  WHERE creator_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS commerce_order_items_product_idx
  ON commerce_order_items (product_id, created_at DESC)
  WHERE product_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS payment_customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'stripe' CHECK (provider IN ('stripe', 'shopify', 'paypal', 'manual')),
  provider_customer_id text NOT NULL,
  default_currency char(3) NOT NULL DEFAULT 'USD',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_customer_id),
  UNIQUE (user_id, provider)
);

CREATE INDEX IF NOT EXISTS payment_customers_user_idx
  ON payment_customers (user_id, provider);

CREATE TABLE IF NOT EXISTS checkout_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  order_id uuid REFERENCES commerce_orders(id) ON DELETE SET NULL,
  provider text NOT NULL DEFAULT 'stripe' CHECK (provider IN ('stripe', 'shopify', 'paypal', 'manual')),
  provider_session_id text NOT NULL,
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'open', 'completed', 'expired', 'cancelled', 'failed')),
  currency char(3) NOT NULL DEFAULT 'USD',
  amount_total_cents integer NOT NULL DEFAULT 0 CHECK (amount_total_cents >= 0),
  success_url text,
  cancel_url text,
  expires_at timestamptz,
  completed_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_session_id)
);

CREATE INDEX IF NOT EXISTS checkout_sessions_user_idx
  ON checkout_sessions (user_id, created_at DESC)
  WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS checkout_sessions_order_idx
  ON checkout_sessions (order_id)
  WHERE order_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS payment_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid REFERENCES commerce_orders(id) ON DELETE SET NULL,
  checkout_session_id uuid REFERENCES checkout_sessions(id) ON DELETE SET NULL,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  provider text NOT NULL DEFAULT 'stripe' CHECK (provider IN ('stripe', 'shopify', 'paypal', 'manual')),
  provider_payment_id text NOT NULL,
  transaction_type text NOT NULL DEFAULT 'payment' CHECK (transaction_type IN ('authorization', 'payment', 'refund', 'chargeback', 'adjustment')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed', 'cancelled', 'refunded')),
  currency char(3) NOT NULL DEFAULT 'USD',
  amount_cents integer NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
  processed_at timestamptz,
  failure_code text,
  failure_message text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_payment_id, transaction_type)
);

CREATE INDEX IF NOT EXISTS payment_transactions_order_idx
  ON payment_transactions (order_id, created_at DESC)
  WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS payment_transactions_user_idx
  ON payment_transactions (user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS checkout_audit_log (
  id bigserial PRIMARY KEY,
  event text NOT NULL,
  pg_id bigint,
  sku_id text,
  price_ron numeric(12, 2),
  client_ip text,
  user_agent text,
  payload jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS checkout_audit_log_event_created_at_idx
  ON checkout_audit_log (event, created_at DESC);

CREATE TABLE IF NOT EXISTS creator_connect_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  creator_profile_id uuid REFERENCES creator_profiles(id) ON DELETE SET NULL,
  provider text NOT NULL DEFAULT 'stripe' CHECK (provider IN ('stripe', 'manual')),
  provider_account_id text NOT NULL,
  account_status text NOT NULL DEFAULT 'created' CHECK (account_status IN ('created', 'onboarding', 'active', 'restricted', 'disabled', 'rejected')),
  charges_enabled boolean NOT NULL DEFAULT false,
  payouts_enabled boolean NOT NULL DEFAULT false,
  details_submitted boolean NOT NULL DEFAULT false,
  country char(2),
  default_currency char(3) NOT NULL DEFAULT 'USD',
  requirements_currently_due text[] NOT NULL DEFAULT ARRAY[]::text[],
  requirements_eventually_due text[] NOT NULL DEFAULT ARRAY[]::text[],
  disabled_reason text,
  onboarding_url text,
  onboarding_expires_at timestamptz,
  last_synced_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_account_id),
  UNIQUE (creator_id, provider)
);

CREATE INDEX IF NOT EXISTS creator_connect_accounts_creator_idx
  ON creator_connect_accounts (creator_id, account_status);
CREATE INDEX IF NOT EXISTS creator_connect_accounts_payouts_idx
  ON creator_connect_accounts (payouts_enabled, account_status);

ALTER TABLE commissions
  ADD COLUMN IF NOT EXISTS commerce_order_id uuid REFERENCES commerce_orders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS commerce_order_item_id uuid REFERENCES commerce_order_items(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS product_id uuid REFERENCES marketplace_products(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS connect_account_id uuid REFERENCES creator_connect_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS payment_transaction_id uuid REFERENCES payment_transactions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS commission_rate_bps integer CHECK (commission_rate_bps IS NULL OR commission_rate_bps BETWEEN 0 AND 10000);

CREATE INDEX IF NOT EXISTS commissions_order_idx
  ON commissions (commerce_order_id, created_at DESC)
  WHERE commerce_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS commissions_order_item_idx
  ON commissions (commerce_order_item_id)
  WHERE commerce_order_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS commissions_connect_account_idx
  ON commissions (connect_account_id, status, created_at DESC)
  WHERE connect_account_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS commission_payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connect_account_id uuid REFERENCES creator_connect_accounts(id) ON DELETE SET NULL,
  provider text NOT NULL DEFAULT 'stripe' CHECK (provider IN ('stripe', 'manual')),
  provider_payout_id text,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'processing', 'paid', 'failed', 'cancelled')),
  currency char(3) NOT NULL DEFAULT 'USD',
  gross_amount_cents integer NOT NULL DEFAULT 0 CHECK (gross_amount_cents >= 0),
  platform_fee_cents integer NOT NULL DEFAULT 0 CHECK (platform_fee_cents >= 0),
  net_amount_cents integer NOT NULL DEFAULT 0 CHECK (net_amount_cents >= 0),
  period_start timestamptz,
  period_end timestamptz,
  scheduled_at timestamptz,
  submitted_at timestamptz,
  paid_at timestamptz,
  failed_at timestamptz,
  failure_code text,
  failure_message text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end IS NULL OR period_start IS NULL OR period_end >= period_start)
);

CREATE UNIQUE INDEX IF NOT EXISTS commission_payouts_provider_payout_uidx
  ON commission_payouts (provider, provider_payout_id)
  WHERE provider_payout_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS commission_payouts_creator_status_idx
  ON commission_payouts (creator_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS commission_payouts_connect_account_idx
  ON commission_payouts (connect_account_id, status)
  WHERE connect_account_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS commission_payout_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_id uuid NOT NULL REFERENCES commission_payouts(id) ON DELETE CASCADE,
  commission_id uuid NOT NULL REFERENCES commissions(id) ON DELETE CASCADE,
  amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payout_id, commission_id)
);

CREATE INDEX IF NOT EXISTS commission_payout_items_commission_idx
  ON commission_payout_items (commission_id);

CREATE TABLE IF NOT EXISTS connect_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  commission_id uuid REFERENCES commissions(id) ON DELETE SET NULL,
  payout_id uuid REFERENCES commission_payouts(id) ON DELETE SET NULL,
  connect_account_id uuid NOT NULL REFERENCES creator_connect_accounts(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'stripe' CHECK (provider IN ('stripe', 'manual')),
  provider_transfer_id text,
  destination_account_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'submitted', 'succeeded', 'failed', 'reversed', 'cancelled')),
  currency char(3) NOT NULL DEFAULT 'USD',
  amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  reversed_amount_cents integer NOT NULL DEFAULT 0 CHECK (reversed_amount_cents >= 0),
  submitted_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  failure_code text,
  failure_message text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS connect_transfers_provider_transfer_uidx
  ON connect_transfers (provider, provider_transfer_id)
  WHERE provider_transfer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS connect_transfers_account_status_idx
  ON connect_transfers (connect_account_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS connect_transfers_commission_idx
  ON connect_transfers (commission_id)
  WHERE commission_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS moderation_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  target_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  target_video_id uuid REFERENCES videos(id) ON DELETE CASCADE,
  target_comment_id uuid REFERENCES comments(id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (reason IN ('spam', 'harassment', 'hate', 'violence', 'sexual_content', 'scam', 'copyright', 'other')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'triaged', 'actioned', 'dismissed', 'duplicate')),
  note text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (target_user_id IS NOT NULL)::integer +
    (target_video_id IS NOT NULL)::integer +
    (target_comment_id IS NOT NULL)::integer = 1
  )
);

CREATE INDEX IF NOT EXISTS moderation_reports_status_idx
  ON moderation_reports (status, created_at DESC);
CREATE INDEX IF NOT EXISTS moderation_reports_reporter_idx
  ON moderation_reports (reporter_user_id, created_at DESC)
  WHERE reporter_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS moderation_reports_target_video_idx
  ON moderation_reports (target_video_id, created_at DESC)
  WHERE target_video_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS moderation_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opened_by_report_id uuid REFERENCES moderation_reports(id) ON DELETE SET NULL,
  assigned_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  target_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  target_video_id uuid REFERENCES videos(id) ON DELETE CASCADE,
  target_comment_id uuid REFERENCES comments(id) ON DELETE CASCADE,
  severity text NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_review', 'resolved', 'dismissed', 'escalated')),
  decision text CHECK (decision IN ('no_action', 'hide', 'delete', 'suspend_user', 'ban_user', 'age_restrict', 'escalate')),
  resolution_note text,
  resolved_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (target_user_id IS NOT NULL)::integer +
    (target_video_id IS NOT NULL)::integer +
    (target_comment_id IS NOT NULL)::integer = 1
  )
);

CREATE INDEX IF NOT EXISTS moderation_cases_status_idx
  ON moderation_cases (status, severity, created_at DESC);
CREATE INDEX IF NOT EXISTS moderation_cases_assigned_idx
  ON moderation_cases (assigned_user_id, status, created_at DESC)
  WHERE assigned_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS moderation_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid REFERENCES moderation_cases(id) ON DELETE SET NULL,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  target_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  target_video_id uuid REFERENCES videos(id) ON DELETE CASCADE,
  target_comment_id uuid REFERENCES comments(id) ON DELETE CASCADE,
  action_type text NOT NULL CHECK (action_type IN ('warn', 'hide', 'delete', 'restore', 'suspend_user', 'ban_user', 'age_restrict', 'payout_hold')),
  reason text,
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR ends_at > starts_at),
  CHECK (
    (target_user_id IS NOT NULL)::integer +
    (target_video_id IS NOT NULL)::integer +
    (target_comment_id IS NOT NULL)::integer >= 1
  )
);

CREATE INDEX IF NOT EXISTS moderation_actions_case_idx
  ON moderation_actions (case_id, created_at DESC)
  WHERE case_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS moderation_actions_target_user_idx
  ON moderation_actions (target_user_id, created_at DESC)
  WHERE target_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS event_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_name text NOT NULL,
  event_type text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  idempotency_key text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  headers jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'publishing', 'published', 'failed', 'dead')),
  available_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS event_outbox_idempotency_uidx
  ON event_outbox (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS event_outbox_dispatch_idx
  ON event_outbox (status, available_at, created_at)
  WHERE status IN ('pending', 'failed');
CREATE INDEX IF NOT EXISTS event_outbox_stream_idx
  ON event_outbox (stream_name, created_at DESC);
CREATE INDEX IF NOT EXISTS event_outbox_payload_gin_idx
  ON event_outbox USING gin (payload jsonb_path_ops);

CREATE TABLE IF NOT EXISTS redis_stream_checkpoints (
  stream_name text NOT NULL,
  consumer_group text NOT NULL,
  consumer_name text NOT NULL,
  last_message_id text NOT NULL DEFAULT '0-0',
  last_delivered_at timestamptz,
  lag_count bigint NOT NULL DEFAULT 0 CHECK (lag_count >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (stream_name, consumer_group, consumer_name)
);

CREATE INDEX IF NOT EXISTS redis_stream_checkpoints_lag_idx
  ON redis_stream_checkpoints (lag_count DESC, updated_at DESC);

CREATE TABLE IF NOT EXISTS feed_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  creator_id uuid REFERENCES users(id) ON DELETE SET NULL,
  source_event_id uuid REFERENCES event_outbox(id) ON DELETE SET NULL,
  feed_type text NOT NULL DEFAULT 'for_you' CHECK (feed_type IN ('for_you', 'following', 'creator', 'product', 'search', 'global')),
  reason text,
  score numeric(12, 6) NOT NULL DEFAULT 0,
  rank_bucket text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'hidden', 'expired')),
  available_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at IS NULL OR expires_at > available_at)
);

CREATE INDEX IF NOT EXISTS feed_items_user_feed_rank_idx
  ON feed_items (user_id, feed_type, score DESC, available_at DESC)
  WHERE user_id IS NOT NULL AND status = 'active';
CREATE INDEX IF NOT EXISTS feed_items_global_rank_idx
  ON feed_items (feed_type, score DESC, available_at DESC)
  WHERE user_id IS NULL AND status = 'active';
CREATE INDEX IF NOT EXISTS feed_items_video_idx
  ON feed_items (video_id, created_at DESC);
CREATE INDEX IF NOT EXISTS feed_items_expires_idx
  ON feed_items (expires_at)
  WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS user_feed_state (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feed_type text NOT NULL DEFAULT 'for_you' CHECK (feed_type IN ('for_you', 'following', 'creator', 'product', 'search', 'global')),
  cursor_token text,
  last_refreshed_at timestamptz,
  last_seen_item_id uuid REFERENCES feed_items(id) ON DELETE SET NULL,
  seen_video_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, feed_type)
);

CREATE INDEX IF NOT EXISTS user_feed_state_refreshed_idx
  ON user_feed_state (last_refreshed_at DESC);

CREATE TABLE IF NOT EXISTS analytics_delivery_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  destination text NOT NULL DEFAULT 'clickhouse' CHECK (destination IN ('clickhouse', 'warehouse', 'other')),
  stream_name text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'sealed', 'delivered', 'failed')),
  event_count integer NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  first_event_at timestamptz,
  last_event_at timestamptz,
  delivered_at timestamptz,
  error_message text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS analytics_delivery_batches_status_idx
  ON analytics_delivery_batches (destination, status, created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_users_set_updated_at') THEN
    CREATE TRIGGER trg_users_set_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION social_set_updated_at();
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_creator_profiles_set_updated_at') THEN
    CREATE TRIGGER trg_creator_profiles_set_updated_at BEFORE UPDATE ON creator_profiles
    FOR EACH ROW EXECUTE FUNCTION social_set_updated_at();
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_videos_set_updated_at') THEN
    CREATE TRIGGER trg_videos_set_updated_at BEFORE UPDATE ON videos
    FOR EACH ROW EXECUTE FUNCTION social_set_updated_at();
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_video_assets_set_updated_at') THEN
    CREATE TRIGGER trg_video_assets_set_updated_at BEFORE UPDATE ON video_assets
    FOR EACH ROW EXECUTE FUNCTION social_set_updated_at();
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_comments_set_updated_at') THEN
    CREATE TRIGGER trg_comments_set_updated_at BEFORE UPDATE ON comments
    FOR EACH ROW EXECUTE FUNCTION social_set_updated_at();
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_creator_collections_set_updated_at') THEN
    CREATE TRIGGER trg_creator_collections_set_updated_at BEFORE UPDATE ON creator_collections
    FOR EACH ROW EXECUTE FUNCTION social_set_updated_at();
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_creator_collection_items_set_updated_at') THEN
    CREATE TRIGGER trg_creator_collection_items_set_updated_at BEFORE UPDATE ON creator_collection_items
    FOR EACH ROW EXECUTE FUNCTION social_set_updated_at();
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_commissions_set_updated_at') THEN
    CREATE TRIGGER trg_commissions_set_updated_at BEFORE UPDATE ON commissions
    FOR EACH ROW EXECUTE FUNCTION social_set_updated_at();
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_notifications_set_updated_at') THEN
    CREATE TRIGGER trg_notifications_set_updated_at BEFORE UPDATE ON notifications
    FOR EACH ROW EXECUTE FUNCTION social_set_updated_at();
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_video_upload_sessions_set_updated_at') THEN
    CREATE TRIGGER trg_video_upload_sessions_set_updated_at BEFORE UPDATE ON video_upload_sessions
    FOR EACH ROW EXECUTE FUNCTION social_set_updated_at();
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_video_processing_jobs_set_updated_at') THEN
    CREATE TRIGGER trg_video_processing_jobs_set_updated_at BEFORE UPDATE ON video_processing_jobs
    FOR EACH ROW EXECUTE FUNCTION social_set_updated_at();
  END IF;
END;
$$;

DO $$
DECLARE
  target_table text;
  trigger_name text;
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'auth_accounts',
    'user_sessions',
    'service_api_keys',
    'creator_applications',
    'marketplace_merchants',
    'marketplace_products',
    'marketplace_product_variants',
    'marketplace_product_offers',
    'creator_product_links',
    'video_product_links',
    'commerce_orders',
    'commerce_order_items',
    'payment_customers',
    'checkout_sessions',
    'payment_transactions',
    'creator_connect_accounts',
    'commission_payouts',
    'connect_transfers',
    'moderation_reports',
    'moderation_cases',
    'moderation_actions',
    'event_outbox',
    'redis_stream_checkpoints',
    'feed_items',
    'user_feed_state',
    'analytics_delivery_batches'
  ] LOOP
    trigger_name := 'trg_' || target_table || '_set_updated_at';

    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = trigger_name) THEN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION social_set_updated_at()',
        trigger_name,
        target_table
      );
    END IF;
  END LOOP;
END;
$$;

COMMIT;
