-- Swypik Go — plăți card autorizate ÎNAINTE de dispatch + taxa de anulare încasată.
-- (2026-09-26, w3-go)
--   1. rides.authorized_amount_cents — suma ținută pe card (capture ≤ această sumă).
--   2. rides.cancel_fee_status — none | charged (capturată pe card) | owed (cash,
--      datorată de pasager) | waived (anulată de admin).
--   3. Index pentru „cursa activă a șoferului" (recuperare după reload).
--   4. Curse card rămase 'requested' fără autorizare nu au plecat niciodată la
--      dispatch — nu se modifică date existente.
-- Idempotent.

BEGIN;

ALTER TABLE rides
  ADD COLUMN IF NOT EXISTS authorized_amount_cents integer,
  ADD COLUMN IF NOT EXISTS payment_authorized_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancel_fee_status text NOT NULL DEFAULT 'none';

DO $$ BEGIN
  ALTER TABLE rides ADD CONSTRAINT rides_cancel_fee_status_chk
    CHECK (cancel_fee_status IN ('none', 'charged', 'owed', 'waived'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Curse anulate istoric cu taxă calculată dar neîncasată: le marcăm 'owed'
-- doar pe cele cash (cele card au avut pre-autorizarea eliberată → pierdute).
UPDATE rides SET cancel_fee_status = 'owed'
 WHERE status = 'cancelled' AND COALESCE(cancel_fee_cents, 0) > 0
   AND payment_method = 'cash' AND cancel_fee_status = 'none';

CREATE INDEX IF NOT EXISTS idx_rides_driver_active
  ON rides (driver_id)
  WHERE status IN ('accepted', 'arriving', 'in_progress');

CREATE INDEX IF NOT EXISTS idx_rides_rider_fee_owed
  ON rides (rider_user_id)
  WHERE cancel_fee_status = 'owed';

COMMIT;
