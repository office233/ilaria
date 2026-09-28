-- ============================================================================
-- Migration: 20260511_0005_media_video_assets
-- Description: Generic media registry for R2/S3 objects.
--
-- Important:
-- The social video schema already creates video_upload_sessions, video_assets,
-- and video_processing_jobs in 20260510_0001_social_marketplace.sql. This
-- migration must not redefine those tables with a different shape, because
-- CREATE TABLE IF NOT EXISTS would silently leave production on the old schema
-- while fresh partial environments could get an incompatible one.
-- ============================================================================

INSERT INTO users (id, username, display_name, role, metadata)
VALUES (
  '00000000-0000-4000-8000-000000000001',
  'swypik-admin',
  'Swypik Admin',
  'admin',
  '{"system": true, "purpose": "admin_video_uploads"}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS media_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type text NOT NULL CHECK (owner_type IN ('product', 'seller', 'creator', 'order', 'system')),
  owner_id uuid,
  type text NOT NULL CHECK (type IN ('image', 'video', 'thumbnail', 'document', 'export', 'backup')),
  bucket text NOT NULL,
  object_key text NOT NULL,
  public_url text,
  mime_type text,
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'processing', 'ready', 'failed', 'deleted')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bucket, object_key)
);

CREATE INDEX IF NOT EXISTS media_assets_owner_idx
  ON media_assets (owner_type, owner_id, created_at DESC);

CREATE INDEX IF NOT EXISTS media_assets_type_status_idx
  ON media_assets (type, status, created_at DESC);

DO $$
BEGIN
  IF to_regprocedure('social_set_updated_at()') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_media_assets_set_updated_at') THEN
    CREATE TRIGGER trg_media_assets_set_updated_at
      BEFORE UPDATE ON media_assets
      FOR EACH ROW EXECUTE FUNCTION social_set_updated_at();
  END IF;
END $$;
