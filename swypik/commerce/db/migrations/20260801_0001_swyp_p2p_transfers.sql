-- Transferuri P2P on-chain: din portofelul custodial al userului către orice
-- adresă Swypik Chain. Jurnal complet pentru audit + idempotență.
CREATE TABLE IF NOT EXISTS swyp_p2p_transfers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_address text NOT NULL,
  to_address   text NOT NULL,
  amount_units bigint NOT NULL CHECK (amount_units > 0),
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','submitted','sent','failed')),
  tx_hash      text UNIQUE,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_swyp_p2p_user ON swyp_p2p_transfers (user_id, created_at DESC);
