-- 20260731_0012_swyp_withdrawals_submitted.sql
-- Fix C-3 (audit bani): status intermediar 'submitted' = tx emisă on-chain,
-- hash persistat, dar chitanța neconfirmată încă. Dacă procesul moare aici,
-- retragerea NU primește refund automat (banii pot fi deja on-chain);
-- reconcilierea verifică chain-ul după tx_hash și decide sent/refund.
-- Idempotent.

ALTER TABLE swyp_withdrawals DROP CONSTRAINT IF EXISTS swyp_withdrawals_status_check;
ALTER TABLE swyp_withdrawals ADD CONSTRAINT swyp_withdrawals_status_check
  CHECK (status IN ('pending', 'submitted', 'sent', 'failed', 'refunded'));

CREATE INDEX IF NOT EXISTS idx_swyp_withdrawals_submitted
  ON swyp_withdrawals (status, created_at) WHERE status = 'submitted';
