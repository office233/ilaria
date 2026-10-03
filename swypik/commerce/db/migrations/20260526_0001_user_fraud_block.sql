-- Auto-block users with repeated fraud-flagged orders.
-- Stored in users.metadata.fraud_user_block JSON to avoid schema churn:
--   { blocked: true, blocked_at: ts, reason, blocked_by: 'auto'|'admin', flagged_order_ids: [..], score_history: [..] }
-- Checked at checkout AND in cron dropship.

-- Partial index for quick "is user fraud-blocked?" lookups.
CREATE INDEX IF NOT EXISTS idx_users_fraud_block
  ON users ((metadata->>'fraud_user_block'))
  WHERE metadata ? 'fraud_user_block';

-- Audit log (decisions on user level — separate from per-order ops_alert_log)
CREATE TABLE IF NOT EXISTS user_fraud_decisions (
  id            BIGSERIAL PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action        TEXT NOT NULL CHECK (action IN ('auto_block','admin_block','admin_unblock')),
  reason        TEXT,
  trigger_order_ids UUID[],
  score_at_decision INTEGER,
  decided_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by    TEXT
);

CREATE INDEX IF NOT EXISTS idx_user_fraud_decisions_user
  ON user_fraud_decisions (user_id, decided_at DESC);
