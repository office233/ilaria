-- Depozite chain → aplicație: userul trimite SWYP nativ către adresa
-- trezoreriei REWARDS; scanner-ul creditează ledger-ul intern.
CREATE TABLE IF NOT EXISTS swyp_chain_deposits (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_address text NOT NULL,
  tx_hash      text NOT NULL UNIQUE,
  block_number bigint NOT NULL,
  amount_wei   numeric(38,0) NOT NULL CHECK (amount_wei > 0),
  amount_units bigint NOT NULL CHECK (amount_units >= 0),
  credited     boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_swyp_chain_deposits_user ON swyp_chain_deposits (user_id, created_at DESC);

-- Cursor: ultimul bloc scanat (un singur rând).
CREATE TABLE IF NOT EXISTS swyp_chain_scan_cursor (
  id           int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_block   bigint NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
INSERT INTO swyp_chain_scan_cursor (id, last_block) VALUES (1, 0) ON CONFLICT DO NOTHING;
