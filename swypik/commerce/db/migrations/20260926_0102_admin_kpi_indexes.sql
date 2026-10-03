-- 20260926_0102_admin_kpi_indexes
--
-- Indexuri pentru dashboard-ul de admin (lib/admin/kpis.ts): utilizatori noi
-- pe interval, joburi eșuate (cron + procesare video) și cazuri de moderare
-- deschise pe clipuri (semnalate automat de AI). Idempotent.

CREATE INDEX IF NOT EXISTS idx_users_created_at ON users (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cron_runs_failed
  ON cron_runs (started_at DESC)
  WHERE status = 'failed';

CREATE INDEX IF NOT EXISTS idx_video_processing_jobs_failed
  ON video_processing_jobs (updated_at DESC)
  WHERE status = 'failed';

CREATE INDEX IF NOT EXISTS idx_moderation_cases_open_video
  ON moderation_cases (created_at ASC)
  WHERE status IN ('open', 'in_review') AND target_video_id IS NOT NULL;
