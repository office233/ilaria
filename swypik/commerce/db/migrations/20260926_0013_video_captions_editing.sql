-- 20260926_0013_video_captions_editing
--
-- Subtitrări editabile de creator: textul generat automat (speech-to-text din
-- audio.m4a scos de worker) poate fi corectat din pasul „Detalii” al uploadului.
-- is_auto = false după o editare; updated_at / edited_by_user_id pentru audit.
-- WebVTT se generează la cerere din `segments` (GET /api/videos/[id]/captions?format=vtt).
-- Idempotent; nimic nu se șterge.

BEGIN;

ALTER TABLE video_captions
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS edited_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL;

COMMIT;
