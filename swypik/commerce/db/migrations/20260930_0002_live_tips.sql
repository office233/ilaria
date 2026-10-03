-- Real-money tips inside Swypik Live, settled through the internal RON wallet.
-- Each tip is one atomic debit(viewer) + credit(creator), keyed idempotently.

BEGIN;

CREATE TABLE IF NOT EXISTS live_tips (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_id         uuid NOT NULL REFERENCES live_streams(id) ON DELETE CASCADE,
  sender_user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  creator_user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents      bigint NOT NULL CHECK (amount_cents BETWEEN 100 AND 50000),
  currency          char(3) NOT NULL DEFAULT 'RON' CHECK (currency = 'RON'),
  idempotency_key   uuid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sender_user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_live_tips_stream_created
  ON live_tips (stream_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_live_tips_creator_created
  ON live_tips (creator_user_id, created_at DESC);

COMMIT;
