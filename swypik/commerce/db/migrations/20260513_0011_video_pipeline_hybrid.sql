-- 20260513_0008_video_pipeline_hybrid.sql
-- Hybrid video pipeline: allow upload sessions to track an external `source_url`
-- (e.g. AliExpress CDN .mp4) so the Python worker can download → FFmpeg → HLS → R2
-- instead of requiring a direct creator upload.
--
-- The base schema (0001) already creates video_upload_sessions / video_processing_jobs
-- and has video_id on both tables; this migration only adds the columns + indexes
-- required for the hybrid pipeline. No existing data is touched.

BEGIN;

-- video_upload_sessions: track the external source URL the worker should pull from.
-- Existing creator uploads (with a presigned PUT) leave this NULL.
ALTER TABLE video_upload_sessions
  ADD COLUMN IF NOT EXISTS source_url text;

-- video_processing_jobs: same column so the worker can read it straight off the job row
-- without re-joining video_upload_sessions.
ALTER TABLE video_processing_jobs
  ADD COLUMN IF NOT EXISTS source_url text;

-- An index on (video_id) already exists from 0001 (video_upload_sessions_video_idx);
-- add a partial index on source_url so we can quickly find/track external pulls.
CREATE INDEX IF NOT EXISTS video_upload_sessions_source_url_idx
  ON video_upload_sessions (source_url)
  WHERE source_url IS NOT NULL;

CREATE INDEX IF NOT EXISTS video_processing_jobs_source_url_idx
  ON video_processing_jobs (source_url)
  WHERE source_url IS NOT NULL;

COMMIT;
