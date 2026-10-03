CREATE TABLE IF NOT EXISTS cron_job_runs (
  id BIGSERIAL PRIMARY KEY,
  job_name TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed')),
  duration_ms INT,
  error TEXT,
  metadata JSONB DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS cron_job_runs_job_started_idx ON cron_job_runs(job_name, started_at DESC);
CREATE INDEX IF NOT EXISTS cron_job_runs_status_idx ON cron_job_runs(status) WHERE status='failed';
INSERT INTO schema_migrations(version) VALUES ('20260518_0002_cron_runs_and_watchdog') ON CONFLICT DO NOTHING;
