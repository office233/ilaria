CREATE TABLE IF NOT EXISTS trending_now (
  id BIGSERIAL PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('hashtag','audio','product','topic')),
  name TEXT NOT NULL,
  score NUMERIC,
  metadata JSONB,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trending_detected ON trending_now(detected_at DESC);
