-- Extracted from app/api/upload/session/route.ts runtime DDL fallback (H6).
-- These CREATE TABLE statements were previously executed on every authenticated
-- request to /api/upload/session. They are moved here to remove catalog-lock
-- contention from the hot path.
--
-- NOTE: video_upload_sessions and video_processing_jobs are also defined in
-- 20260510_0001_social_marketplace.sql with a different (canonical) schema
-- (user_id / object_key / expires_at). These IF NOT EXISTS statements are
-- preserved verbatim from the route for historical reference but will be
-- no-ops on databases where 0001 has been applied. The column mismatch
-- between the route's INSERT and the canonical schema needs a separate
-- reconciliation migration (out of scope for H6).

CREATE TABLE IF NOT EXISTS video_upload_sessions (
  id UUID PRIMARY KEY,
  creator_id UUID NOT NULL,
  product_id UUID,
  raw_object_key TEXT NOT NULL,
  status VARCHAR(50) DEFAULT 'created',
  upload_expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS video_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_session_id UUID REFERENCES video_upload_sessions(id),
  creator_id UUID NOT NULL,
  product_id UUID,
  raw_key TEXT,
  hls_master_key TEXT,
  thumbnail_key TEXT,
  preview_key TEXT,
  duration_seconds INTEGER,
  width INTEGER,
  height INTEGER,
  status VARCHAR(50) DEFAULT 'processing',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS video_processing_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_asset_id UUID REFERENCES video_assets(id),
  status VARCHAR(50) DEFAULT 'queued',
  error TEXT,
  started_at TIMESTAMP WITH TIME ZONE,
  finished_at TIMESTAMP WITH TIME ZONE
);
