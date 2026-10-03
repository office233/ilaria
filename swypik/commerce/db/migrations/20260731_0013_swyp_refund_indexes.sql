-- Indexuri pentru fluxul de reversare SWYP (webhook + cron reclaim).
--  1. Cronul reclaim-abandoned-swyp scanează comenzile neplătite cu parte
--     SWYP debitată — index parțial, setul e mic.
--  2. Guard-ul anti-dublă-creditare caută în ledger reversările unei comenzi
--     după metadata->>'order_id' — index pe expresie, doar pe adjustments.

CREATE INDEX IF NOT EXISTS idx_commerce_orders_swyp_unpaid
  ON commerce_orders (created_at)
  WHERE swyp_paid_cents > 0 AND status IN ('pending', 'cancelled', 'failed');

CREATE INDEX IF NOT EXISTS idx_swyp_ledger_refund_order
  ON swyp_ledger_entries ((metadata->>'order_id'))
  WHERE kind = 'adjustment';
