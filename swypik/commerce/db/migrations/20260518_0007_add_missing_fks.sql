-- 20260518_0007_add_missing_fks.sql
-- Add missing FKs identified by audit cont-18:
--   media_assets.owner_id -> users(id)
--   video_captions.video_id -> videos(id)
-- Orphan check at apply time: 0 rows.
-- Uses NOT VALID + VALIDATE pattern: short lock for ADD, no full-table scan
-- under exclusive lock during VALIDATE.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'media_assets_owner_id_fkey'
  ) THEN
    ALTER TABLE media_assets
      ADD CONSTRAINT media_assets_owner_id_fkey
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL
      NOT VALID;
    ALTER TABLE media_assets VALIDATE CONSTRAINT media_assets_owner_id_fkey;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'video_captions_video_id_fkey'
  ) THEN
    ALTER TABLE video_captions
      ADD CONSTRAINT video_captions_video_id_fkey
      FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
      NOT VALID;
    ALTER TABLE video_captions VALIDATE CONSTRAINT video_captions_video_id_fkey;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_media_assets_owner_id ON media_assets(owner_id) WHERE owner_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_video_captions_video_id ON video_captions(video_id);
