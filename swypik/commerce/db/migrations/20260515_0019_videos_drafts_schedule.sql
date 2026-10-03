ALTER TABLE videos
  ADD COLUMN IF NOT EXISTS is_draft BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS allow_duet BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS allow_stitch BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS allow_comments BOOLEAN NOT NULL DEFAULT true;
CREATE INDEX IF NOT EXISTS idx_videos_creator_draft ON videos(creator_id) WHERE is_draft = true;
CREATE INDEX IF NOT EXISTS idx_videos_scheduled ON videos(scheduled_publish_at) WHERE scheduled_publish_at IS NOT NULL;
