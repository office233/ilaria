-- 20260926_0011_video_processing_progress
--
-- Progres real de procesare (în locul barei false „95%” din wizard):
-- workerul scrie etapa (downloading → probing → transcoding → uploading →
-- done / retrying) și procentul; UI-ul le citește prin
-- GET /api/creator/upload-session/[id]. `error_code` exista deja și e folosit
-- pentru mesaje de eroare traduse (duration_too_long, no_video_stream, …).
-- Idempotent; nimic nu se șterge.

BEGIN;

ALTER TABLE video_processing_jobs
  ADD COLUMN IF NOT EXISTS stage text,
  ADD COLUMN IF NOT EXISTS progress smallint;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'video_processing_jobs_progress_check'
  ) THEN
    ALTER TABLE video_processing_jobs
      ADD CONSTRAINT video_processing_jobs_progress_check
      CHECK (progress IS NULL OR progress BETWEEN 0 AND 100);
  END IF;
END $$;

-- Joburile deja terminate primesc etapa finală (UI-ul nu vede NULL la clipurile vechi).
UPDATE video_processing_jobs
   SET stage = 'done', progress = 100
 WHERE status = 'succeeded' AND stage IS NULL;

COMMIT;
