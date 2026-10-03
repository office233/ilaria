-- 20260518_0008_orders_status_disputed.sql
-- Stripe webhook handler uses status='disputed' for charge.dispute.created,
-- but the existing CHECK constraint allows only pending|authorized|paid|fulfilled|
-- delivered|return_requested|cancelled|refunded|failed. Add 'disputed' so
-- chargebacks can be recorded properly.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commerce_orders_status_check') THEN
    ALTER TABLE commerce_orders DROP CONSTRAINT commerce_orders_status_check;
  END IF;
  ALTER TABLE commerce_orders ADD CONSTRAINT commerce_orders_status_check
    CHECK (status = ANY (ARRAY[
      'pending'::text,
      'authorized'::text,
      'paid'::text,
      'fulfilled'::text,
      'delivered'::text,
      'return_requested'::text,
      'cancelled'::text,
      'refunded'::text,
      'failed'::text,
      'disputed'::text
    ]));
END $$;
