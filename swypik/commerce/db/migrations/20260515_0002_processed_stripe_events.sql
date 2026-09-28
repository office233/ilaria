-- ============================================================================
-- Migration: 20260515_0002_processed_stripe_events
-- Description: Idempotency table for Stripe webhook events. Each event.id is
--              inserted exactly once on first delivery; subsequent retries are
--              recognized as duplicates and acked without re-running the
--              business logic. Critical fix for double-processing risk.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS processed_stripe_events (
  event_id     TEXT PRIMARY KEY,
  event_type   TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_processed_stripe_events_processed_at
  ON processed_stripe_events(processed_at);

INSERT INTO schema_migrations (version)
VALUES ('20260515_0002_processed_stripe_events')
ON CONFLICT (version) DO NOTHING;

COMMIT;
