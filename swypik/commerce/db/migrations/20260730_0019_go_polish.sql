-- ============================================================================
-- GO POLISH — date vehicul șofer + share trip token
-- Idempotent.
-- ============================================================================

BEGIN;

-- Date vehicul pe couriers (afișate riderului după accept)
ALTER TABLE couriers
  ADD COLUMN IF NOT EXISTS vehicle_make  text,
  ADD COLUMN IF NOT EXISTS vehicle_model text,
  ADD COLUMN IF NOT EXISTS vehicle_color text;

-- Share trip: token public (pagină /go/track/[token]), expiră la final + 1h
ALTER TABLE rides
  ADD COLUMN IF NOT EXISTS share_token      text,
  ADD COLUMN IF NOT EXISTS share_expires_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS rides_share_token_key
  ON rides (share_token) WHERE share_token IS NOT NULL;

COMMIT;
