-- 20260928_42_local_orders_card_hold
--
-- Audit food-go #7: comenzile Food cu cardul erau încasate imediat (capture
-- automat) și puteau rămâne blocate cu banii luați. Acum cardul e doar autorizat
-- la plasare (capture_method=manual) și încasat la acceptarea restaurantului.
--   payment_authorized_at — momentul în care hold-ul a fost verificat la Stripe
--   (payment_status rămâne 'pending' până la încasare; fără schimbare de CHECK).
--   merchant_notified_at — push-ul „comandă nouă" către restaurant a plecat
--   (o singură dată: cash la plasare, card după autorizare).
-- Indexul servește watchdog-ul care anulează comenzile 'placed' neacceptate.
-- Idempotent; nu șterge nimic.

BEGIN;

ALTER TABLE local_orders ADD COLUMN IF NOT EXISTS payment_authorized_at timestamptz;
ALTER TABLE local_orders ADD COLUMN IF NOT EXISTS merchant_notified_at timestamptz;

CREATE INDEX IF NOT EXISTS local_orders_placed_stale_idx
  ON local_orders (placed_at)
  WHERE status = 'placed';

COMMIT;
