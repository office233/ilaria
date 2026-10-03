-- Migration 20260518_0007_ae_import_jobs
-- Tracks bulk AliExpress import progress (resumable, idempotent).
BEGIN;

CREATE TABLE IF NOT EXISTS ae_import_jobs (
  product_id      text PRIMARY KEY,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','running','done','failed','skipped')),
  category_hint   text,
  source_files    text[] NOT NULL DEFAULT '{}',
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text,
  imported_db_id  uuid,
  fetched_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ae_import_jobs_status_idx
  ON ae_import_jobs(status, updated_at DESC);

CREATE INDEX IF NOT EXISTS ae_import_jobs_failed_idx
  ON ae_import_jobs(status, attempts)
  WHERE status = 'failed';

-- Touch trigger
CREATE OR REPLACE FUNCTION tg_ae_import_jobs_touch() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_ae_import_jobs_touch ON ae_import_jobs;
CREATE TRIGGER trg_ae_import_jobs_touch
  BEFORE UPDATE ON ae_import_jobs
  FOR EACH ROW EXECUTE FUNCTION tg_ae_import_jobs_touch();

COMMIT;
