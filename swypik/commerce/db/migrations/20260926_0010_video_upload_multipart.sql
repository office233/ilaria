-- 20260926_0010_video_upload_multipart
--
-- Upload video real reluabil: S3 multipart (init → part-uri presemnate →
-- complete/abort) prin /api/creator/upload-session.
--   video_upload_sessions.upload_id  = UploadId-ul multipart S3 (era o copie a id-ului)
--   part_size / total_parts          = împărțirea fișierului, stabilită la init
--   trim_start_ms / trim_end_ms      = tăierea aleasă de creator (aplicată de worker)
--
-- Un singur job activ per clip: `complete` e idempotent, iar un index unic
-- parțial blochează al doilea job 'queued'/'running' pe același video (dublu
-- click, retry de rețea). Duplicatele existente se anulează înainte (rămâne
-- doar cel mai recent), altfel indexul nu s-ar putea crea.
-- Idempotent; nimic nu se șterge.

BEGIN;

ALTER TABLE video_upload_sessions
  ADD COLUMN IF NOT EXISTS part_size bigint,
  ADD COLUMN IF NOT EXISTS total_parts integer,
  ADD COLUMN IF NOT EXISTS trim_start_ms integer,
  ADD COLUMN IF NOT EXISTS trim_end_ms integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'video_upload_sessions_parts_check'
  ) THEN
    ALTER TABLE video_upload_sessions
      ADD CONSTRAINT video_upload_sessions_parts_check CHECK (
        (part_size IS NULL OR part_size > 0)
        AND (total_parts IS NULL OR total_parts BETWEEN 1 AND 10000)
        AND (trim_start_ms IS NULL OR trim_start_ms >= 0)
        AND (trim_end_ms IS NULL OR trim_start_ms IS NULL OR trim_end_ms > trim_start_ms)
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS video_upload_sessions_user_open_idx
  ON video_upload_sessions (user_id, created_at DESC)
  WHERE status IN ('created', 'uploading');

-- Duplicatele active (mai multe joburi queued/running pe același clip):
-- păstrăm cel mai recent, restul devin 'cancelled'.
UPDATE video_processing_jobs j
   SET status = 'cancelled',
       error_code = 'duplicate_job',
       completed_at = NOW(),
       updated_at = NOW()
 WHERE j.status IN ('queued', 'running')
   AND EXISTS (
     SELECT 1 FROM video_processing_jobs newer
      WHERE newer.video_id = j.video_id
        AND newer.status IN ('queued', 'running')
        AND (newer.created_at, newer.id) > (j.created_at, j.id)
   );

CREATE UNIQUE INDEX IF NOT EXISTS video_processing_jobs_one_active_per_video
  ON video_processing_jobs (video_id)
  WHERE status IN ('queued', 'running') AND job_type = 'transcode';

COMMIT;
