-- 20260731_0008_orders_swyp_payment.sql
-- Plată hibridă cu SWYP pentru comenzi (același model ca la curse:
-- rides.swyp_paid_cents, migrarea 20260731_0004).
--   swyp_paid_cents = -1  → intenție exprimată la checkout, neprocesată încă
--   swyp_paid_cents >= 0  → cenți acoperiți efectiv din SWYP
-- Idempotent.

ALTER TABLE commerce_orders
  ADD COLUMN IF NOT EXISTS swyp_paid_cents integer NOT NULL DEFAULT 0;

-- Plafonul de plată în SWYP (% din total). Platforma trebuie să încaseze
-- și bani reali la fiecare tranzacție, altfel fondul de acoperire nu crește.
INSERT INTO platform_config (key, value)
VALUES ('swyp_max_payment_pct', '50'::jsonb)
ON CONFLICT (key) DO NOTHING;
