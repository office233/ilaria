-- 20260926_0031_local_orders_refunds
--
-- Swypik Food — anulări și rambursări pe comenzile locale.
-- Înainte, refuzul/anularea unei comenzi plătite cu cardul NU returna banii
-- (push-ul spunea totuși „Nu ai fost taxat"). Acum lib/food/refund.ts face
-- refund Stripe (sau anulează PaymentIntent-ul neconfirmat) și, dacă comanda
-- fusese decontată, inversează intrările din wallet ledger.
--
--   refund_status: none | not_required | pending | succeeded | failed
--   cancelled_by : customer | merchant | admin | system
-- Idempotent; nu șterge nimic.

BEGIN;

ALTER TABLE local_orders
  ADD COLUMN IF NOT EXISTS refund_status text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS refund_id text,
  ADD COLUMN IF NOT EXISTS refund_amount_cents integer,
  ADD COLUMN IF NOT EXISTS refunded_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by text,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'local_orders_refund_status_check') THEN
    ALTER TABLE local_orders ADD CONSTRAINT local_orders_refund_status_check
      CHECK (refund_status IN ('none', 'not_required', 'pending', 'succeeded', 'failed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'local_orders_cancelled_by_check') THEN
    ALTER TABLE local_orders ADD CONSTRAINT local_orders_cancelled_by_check
      CHECK (cancelled_by IS NULL OR cancelled_by IN ('customer', 'merchant', 'admin', 'system'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS local_orders_refund_pending_idx
  ON local_orders (refund_status)
  WHERE refund_status IN ('pending', 'failed');

COMMIT;
