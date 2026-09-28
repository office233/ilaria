-- 20260513_0008_video_ai_suggestions.sql
-- Adaugă coloane pentru AI suggestions pe upload-ul creator-ului.
-- - ai_suggestions: snapshot-ul JSON al sugestiilor (audit + cache local).
-- - ai_hook_selected: hook-ul ales de creator (acceptance tracking).
-- - ai_caption_used: dacă caption-ul AI a fost folosit ca-atare / editat.

BEGIN;

ALTER TABLE videos
  ADD COLUMN IF NOT EXISTS ai_suggestions JSONB,
  ADD COLUMN IF NOT EXISTS ai_hook_selected TEXT,
  ADD COLUMN IF NOT EXISTS ai_caption_used BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_videos_ai_hook_selected
  ON videos (creator_id, ai_caption_used)
  WHERE ai_hook_selected IS NOT NULL;

COMMIT;
