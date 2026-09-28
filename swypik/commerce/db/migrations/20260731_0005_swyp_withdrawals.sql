-- 20260731_0005_swyp_withdrawals.sql
-- Bridge app → Swypik Chain: evidența retragerilor on-chain.
-- Fluxul e în doi pași, deliberat:
--   1) debit idempotent din ledgerul intern + rând 'pending' aici (o tranzacție DB);
--   2) transfer on-chain; la succes marcăm 'sent' cu tx_hash, la eșec 'failed'
--      și RESTITUIM soldul (tot idempotent, pe ref_id-ul retragerii).
-- Așa nu putem pierde bani nici dacă procesul moare între pași.
-- Idempotent.

CREATE TABLE IF NOT EXISTS swyp_withdrawals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_address    text NOT NULL,
  amount_units  bigint NOT NULL CHECK (amount_units > 0),
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'sent', 'failed', 'refunded')),
  tx_hash       text UNIQUE,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz
);

CREATE INDEX IF NOT EXISTS idx_swyp_withdrawals_user ON swyp_withdrawals (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_swyp_withdrawals_pending ON swyp_withdrawals (status) WHERE status = 'pending';
