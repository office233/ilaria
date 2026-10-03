CREATE TABLE IF NOT EXISTS video_captions (
  id BIGSERIAL PRIMARY KEY,
  video_id UUID NOT NULL,
  lang TEXT NOT NULL,
  text TEXT NOT NULL,
  segments JSONB,
  is_auto BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (video_id, lang)
);
CREATE INDEX IF NOT EXISTS idx_video_captions_video ON video_captions(video_id);
