-- P1.5: plata cu cardul pentru rezervări de cazare — stocăm intent-ul Stripe
-- direct pe rezervare (refolosire idempotentă + reconciliere webhook).
ALTER TABLE stay_bookings
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id text;
CREATE INDEX IF NOT EXISTS idx_sb_stripe_intent
  ON stay_bookings (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;
