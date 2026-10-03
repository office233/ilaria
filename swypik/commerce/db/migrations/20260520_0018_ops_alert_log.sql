-- Migration: 20260520_0018_ops_alert_log.sql
-- Persistent log + cooldown tracking for ops alerts (used by
-- /api/cron/alert-video-queue and future ops cron alert endpoints).

BEGIN;

CREATE TABLE IF NOT EXISTS ops_alert_log (
  id          BIGSERIAL PRIMARY KEY,
  alert_key   TEXT NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  alerted_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ops_alert_log_key_time
  ON ops_alert_log (alert_key, alerted_at DESC);

COMMIT;
