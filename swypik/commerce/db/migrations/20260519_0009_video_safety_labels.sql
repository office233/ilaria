-- Migration 0009: video_safety_labels — parallel pipeline to product_safety_labels.

CREATE TABLE IF NOT EXISTS video_safety_labels (
  video_id            UUID PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
  label               TEXT NOT NULL CHECK (label IN ('safe','sensitive','adult','blocked')),
  classifier_version  TEXT NOT NULL DEFAULT 'v2',
  signals             JSONB NOT NULL DEFAULT '{}'::jsonb,
  reasons             TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
  reviewed_by_human   BOOLEAN NOT NULL DEFAULT FALSE,
  reviewed_at         TIMESTAMPTZ,
  reviewed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  human_override_label TEXT CHECK (human_override_label IN ('safe','sensitive','adult','blocked')),
  classified_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_video_safety_labels_label ON video_safety_labels(label);
CREATE INDEX IF NOT EXISTS idx_video_safety_labels_unreviewed
  ON video_safety_labels(classified_at)
  WHERE reviewed_by_human = FALSE AND label IN ('sensitive','adult');

CREATE OR REPLACE FUNCTION video_safety_labels_touch()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_video_safety_labels_touch ON video_safety_labels;
CREATE TRIGGER trg_video_safety_labels_touch
  BEFORE UPDATE ON video_safety_labels
  FOR EACH ROW
  EXECUTE FUNCTION video_safety_labels_touch();

CREATE OR REPLACE VIEW video_effective_safety AS
SELECT
  video_id,
  COALESCE(human_override_label, label) AS effective_label,
  reasons,
  reviewed_by_human
FROM video_safety_labels;

-- Auto-label trigger: every new video gets 'sensitive' (fail-closed) until classified.
CREATE OR REPLACE FUNCTION auto_create_video_safety_label()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO video_safety_labels (
    video_id, label, classifier_version, reasons, signals
  ) VALUES (
    NEW.id,
    'sensitive',
    'auto_pending',
    ARRAY['pending_classification']::text[],
    '{"pending": true}'::jsonb
  )
  ON CONFLICT (video_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_videos_auto_safety ON videos;
CREATE TRIGGER trg_videos_auto_safety
  AFTER INSERT ON videos
  FOR EACH ROW
  EXECUTE FUNCTION auto_create_video_safety_label();

COMMENT ON TABLE video_safety_labels IS
'4-level safety classification for videos; mirrors product_safety_labels.';

INSERT INTO schema_migrations (version) VALUES ('20260519_0009_video_safety_labels')
ON CONFLICT (version) DO NOTHING;
