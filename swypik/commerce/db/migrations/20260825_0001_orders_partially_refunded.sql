-- ============================================================================
-- Migration: 20260825_0001_orders_partially_refunded
-- Description: Adauga starea 'partially_refunded' pe commerce_orders.
--
-- DE CE (audit 2026-08-25, bug critic pe bani): un refund PARTIAL din Stripe
-- Dashboard (ex. 20 RON bunavointa pentru un singur item defect dintr-o comanda
-- de 300 RON cu 3 selleri) marca INTREAGA comanda 'refunded' — stare terminala
-- care oprea payout-urile celorlalti selleri, anula itemele nelivrate si revoca
-- toate recompensele SWYP. Handler-ul distinge acum partial de total, iar
-- refund-ul partial scrie 'partially_refunded'. Fara aceasta stare in CHECK,
-- UPDATE-ul ar esua cu violare de constrangere.
--
-- Payout-ul (process-payouts) exclude explicit doar starile terminale
-- ('refunded','cancelled','return_requested','failed') — 'partially_refunded'
-- NU e in lista, deci restul comenzii ramane platibil, exact ce vrem.
-- ============================================================================

BEGIN;

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
      'partially_refunded'::text,
      'failed'::text,
      'disputed'::text
    ]));
END $$;

INSERT INTO schema_migrations (version)
VALUES ('20260825_0001_orders_partially_refunded')
ON CONFLICT (version) DO NOTHING;

COMMIT;
