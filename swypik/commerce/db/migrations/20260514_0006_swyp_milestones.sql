-- 20260514_0006: SWYP gamification — video milestones + per-user streak counter.
CREATE TABLE IF NOT EXISTS video_milestones (
  video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  milestone text NOT NULL,
  awarded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (video_id, milestone)
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS swyp_streak int NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS swyp_streak_last_claim_at timestamptz;

-- Idempotency index for award helper.
CREATE INDEX IF NOT EXISTS wallet_tx_metadata_order_id_idx
  ON wallet_transactions ((metadata->>'order_id'))
  WHERE metadata ? 'order_id';

INSERT INTO schema_migrations (version, applied_at)
VALUES ('20260514_0006', now())
ON CONFLICT DO NOTHING;
