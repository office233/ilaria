-- Plata curselor cu SWYP + aliniere enum payment_method.
-- (Zod accepta card_online/card_courier dar CHECK-ul permitea doar cash/card/wallet.)
ALTER TABLE rides DROP CONSTRAINT IF EXISTS rides_payment_method_check;
ALTER TABLE rides ADD CONSTRAINT rides_payment_method_check
  CHECK (payment_method IN ('cash', 'card', 'card_online', 'card_courier', 'wallet', 'swyp'));

-- Câți cenți din tarif au fost acoperiți cu SWYP (plată hibridă).
ALTER TABLE rides ADD COLUMN IF NOT EXISTS swyp_paid_cents integer NOT NULL DEFAULT 0;
