-- 20260926_0050_stays_booking_lifecycle
--
-- Ciclul de viață al rezervărilor Stays (audit stays.md, P0 + „calendar DoS”):
--
--   pending    → creată, așteaptă plata; expiră la expires_at (implicit 15 min)
--   requested  → plata e AUTORIZATĂ (card: hold Stripe, capture_method=manual;
--                wallet: sumă debitată), așteaptă răspunsul gazdei până la
--                expires_at (implicit 24h)
--   confirmed  → gazda a acceptat: cardul e capturat, gazda creditată (net)
--   completed  → sejur încheiat (cron, după check-out)
--   declined   → gazda a refuzat: hold eliberat / wallet rambursat
--   expired    → n-a plătit la timp sau gazda n-a răspuns la timp
--   cancelled  → anulată de client/gazdă (refund conform politicii)
--
-- payment_status: pending | authorized | paid | refunded | partially_refunded
--                 | failed | voided
--
-- Constraint-ul EXCLUDE (anti dublă rezervare) acoperă acum și 'requested'.
-- Rezervările 'pending' EXPIRATE nu mai blochează calendarul: cererile noi le
-- trec întâi în 'expired' (în aceeași tranzacție), iar cron-ul
-- /api/cron/stays-lifecycle le curăță la 5 minute.
--
-- Idempotent. Nu se șterge nimic; constraint-urile CHECK/EXCLUDE sunt
-- înlocuite cu variante mai largi (nicio rezervare existentă nu le încalcă).

ALTER TABLE stay_bookings
  ADD COLUMN IF NOT EXISTS host_user_id uuid,
  ADD COLUMN IF NOT EXISTS payment_method text,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS decided_at timestamptz,
  ADD COLUMN IF NOT EXISTS decline_reason text,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by text,
  ADD COLUMN IF NOT EXISTS refund_cents integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- CHECK-urile inițiale pe status/payment_status (20260729_0003) au nume
-- generate de Postgres; le găsim după definiție ca să nu rămână unul vechi
-- care ar respinge statusurile noi.
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'stay_bookings'::regclass AND contype = 'c'
       AND conname NOT IN ('stay_bookings_status_check', 'stay_bookings_payment_status_check')
       AND pg_get_constraintdef(oid) ~ 'status'
       AND pg_get_constraintdef(oid) ~ '''pending'''
  LOOP
    EXECUTE format('ALTER TABLE stay_bookings DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

-- Statusuri noi (înlocuiește CHECK-ul inițial din 20260729_0003).
ALTER TABLE stay_bookings DROP CONSTRAINT IF EXISTS stay_bookings_status_check;
ALTER TABLE stay_bookings ADD CONSTRAINT stay_bookings_status_check
  CHECK (status IN ('pending','requested','confirmed','completed','declined','expired','cancelled'));

-- 'failed' lipsea → markStayBookingCardFailed arunca pe constraint (P0).
ALTER TABLE stay_bookings DROP CONSTRAINT IF EXISTS stay_bookings_payment_status_check;
ALTER TABLE stay_bookings ADD CONSTRAINT stay_bookings_payment_status_check
  CHECK (payment_status IN ('pending','authorized','paid','refunded','partially_refunded','failed','voided'));

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stay_bookings_payment_method_check') THEN
    ALTER TABLE stay_bookings ADD CONSTRAINT stay_bookings_payment_method_check
      CHECK (payment_method IS NULL OR payment_method IN ('card','wallet'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stay_bookings_cancelled_by_check') THEN
    ALTER TABLE stay_bookings ADD CONSTRAINT stay_bookings_cancelled_by_check
      CHECK (cancelled_by IS NULL OR cancelled_by IN ('guest','host','system'));
  END IF;
END $$;

-- Anti dublă rezervare: include și 'requested' (plata ținută, gazda decide).
CREATE EXTENSION IF NOT EXISTS btree_gist;
DO $$
DECLARE def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conname = 'stay_no_overlap';
  IF def IS NULL OR position('requested' IN def) = 0 THEN
    ALTER TABLE stay_bookings DROP CONSTRAINT IF EXISTS stay_no_overlap;
    ALTER TABLE stay_bookings ADD CONSTRAINT stay_no_overlap
      EXCLUDE USING gist (
        product_id WITH =,
        daterange(check_in, check_out) WITH &&
      ) WHERE (status IN ('pending','requested','confirmed'));
  END IF;
END $$;

-- Backfill: gazda denormalizată pe rezervare (listări modelul A).
UPDATE stay_bookings b
   SET host_user_id = (p.metadata->>'host_user_id')::uuid
  FROM marketplace_products p
 WHERE p.id = b.product_id
   AND b.host_user_id IS NULL
   AND p.metadata->>'host_user_id' ~* '^[0-9a-f-]{36}$';

-- Rezervările vechi plătite = plată pe wallet (singura cale folosită în UI).
UPDATE stay_bookings SET payment_method = 'wallet'
 WHERE payment_method IS NULL AND payment_status = 'paid' AND stripe_payment_intent_id IS NULL;
UPDATE stay_bookings SET payment_method = 'card'
 WHERE payment_method IS NULL AND stripe_payment_intent_id IS NOT NULL;

-- Calendar DoS: hold-urile neplătite vechi eliberează intervalul.
UPDATE stay_bookings
   SET status = 'expired', updated_at = now()
 WHERE status = 'pending' AND payment_status <> 'paid'
   AND created_at < now() - interval '1 hour';

-- Rezervările pending rămase primesc termen de plată.
UPDATE stay_bookings SET expires_at = created_at + interval '15 minutes'
 WHERE status = 'pending' AND expires_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_sb_lifecycle
  ON stay_bookings (status, expires_at)
  WHERE status IN ('pending','requested');
CREATE INDEX IF NOT EXISTS idx_sb_host ON stay_bookings (host_user_id, check_in DESC);
CREATE INDEX IF NOT EXISTS idx_sb_guest ON stay_bookings (guest_user_id, created_at DESC);
