-- Normalize creator payout states used by earnings, refunds, and payout cron.

BEGIN;

ALTER TABLE commerce_order_items
  ADD COLUMN IF NOT EXISTS payout_status text;

ALTER TABLE commerce_order_items
  DROP CONSTRAINT IF EXISTS commerce_order_items_payout_status_check;

ALTER TABLE commerce_order_items
  ADD CONSTRAINT commerce_order_items_payout_status_check
  CHECK (
    payout_status IS NULL OR payout_status IN (
      'not_connected',
      'pending',
      'paid',
      'failed',
      'no_account',
      'restricted',
      'refunded'
    )
  );

COMMIT;
