CREATE TABLE IF NOT EXISTS cron_runs (
  id BIGSERIAL PRIMARY KEY,
  job_name TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  status TEXT CHECK (status IN ('running','success','failed')),
  duration_ms INT,
  result JSONB,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_cron_runs_job_name_started ON cron_runs (job_name, started_at DESC);
