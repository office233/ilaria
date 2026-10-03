-- Migration 0004: Schema Alignment
-- Consolidates ALL runtime DDL (CREATE TABLE / ALTER TABLE) that was
-- scattered across route handlers into a single, auditable migration.
-- After running this, NO route should ever issue DDL statements.

BEGIN;

-- ═══════════════════════════════════════════════════════════════════
-- 1. CREATORS TABLE (was created at runtime by /api/apply-creator)
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS creators (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  email         TEXT UNIQUE NOT NULL,
  social_link   TEXT NOT NULL,
  followers     TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'active', 'suspended', 'rejected')),
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS creators_status_idx ON creators (status, created_at DESC);

-- ═══════════════════════════════════════════════════════════════════
-- 2. CREATOR_VIDEOS TABLE (was created at runtime by /api/creator/video)
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS creator_videos (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id    TEXT NOT NULL,
  product_id    TEXT NOT NULL,
  video_url     TEXT,
  description   TEXT,
  status        TEXT NOT NULL DEFAULT 'processing'
                  CHECK (status IN ('processing', 'ready', 'rejected', 'failed')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS creator_videos_status_idx ON creator_videos (status, created_at DESC);
CREATE INDEX IF NOT EXISTS creator_videos_creator_idx ON creator_videos (creator_id);
CREATE INDEX IF NOT EXISTS creator_videos_product_idx ON creator_videos (product_id);

-- ═══════════════════════════════════════════════════════════════════
-- 3. COMMERCE_ORDER_ITEMS — add payout_status column
--    (was ALTER'd at runtime by /api/cron/process-payouts)
-- ═══════════════════════════════════════════════════════════════════
ALTER TABLE commerce_order_items
  ADD COLUMN IF NOT EXISTS payout_status TEXT DEFAULT NULL;

CREATE INDEX IF NOT EXISTS commerce_order_items_payout_status_idx
  ON commerce_order_items (payout_status)
  WHERE payout_status IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════
-- 4. SELLERS TABLE — ensure all columns exist
--    (was ALTER'd at runtime by old /api/apply-seller)
-- ═══════════════════════════════════════════════════════════════════
-- These are already in migration 0003 but we keep them here as
-- idempotent safety net for environments that skipped 0003.
ALTER TABLE sellers
  ADD COLUMN IF NOT EXISTS cui          TEXT,
  ADD COLUMN IF NOT EXISTS phone        TEXT,
  ADD COLUMN IF NOT EXISTS product_type TEXT,
  ADD COLUMN IF NOT EXISTS metadata     JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMIT;
