-- ============================================================================
-- FRONT R4 — Swypik Go: completare tabelă rides + ratings + stops
-- Idempotent.
-- ============================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Coloane noi pe rides (trasabilitate pricing + dispatch + plăți + anulare)
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE rides
  ADD COLUMN IF NOT EXISTS job_id uuid,
  ADD COLUMN IF NOT EXISTS vehicle_class text NOT NULL DEFAULT 'economy'
    CHECK (vehicle_class IN ('economy', 'comfort', 'van')),
  ADD COLUMN IF NOT EXISTS city text NOT NULL DEFAULT 'București',
  ADD COLUMN IF NOT EXISTS distance_km numeric(8,3),
  ADD COLUMN IF NOT EXISTS duration_min integer,
  ADD COLUMN IF NOT EXISTS surge_multiplier numeric(3,2) NOT NULL DEFAULT 1.00,
  ADD COLUMN IF NOT EXISTS fare_breakdown jsonb,
  ADD COLUMN IF NOT EXISTS payment_method text NOT NULL DEFAULT 'cash'
    CHECK (payment_method IN ('cash', 'card', 'wallet')),
  ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT 'pending'
    CHECK (payment_status IN ('pending', 'paid', 'refunded', 'failed')),
  ADD COLUMN IF NOT EXISTS cancel_reason text,
  ADD COLUMN IF NOT EXISTS cancelled_by text
    CHECK (cancelled_by IN ('rider', 'driver', 'system')),
  ADD COLUMN IF NOT EXISTS cancel_fee_cents integer,
  ADD COLUMN IF NOT EXISTS accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS arrived_at timestamptz,
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_rides_rider ON rides (rider_user_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_rides_driver ON rides (driver_id)
  WHERE driver_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rides_active ON rides (status)
  WHERE status NOT IN ('completed', 'cancelled');

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Ratinguri bidirecționale (rider → driver, driver → rider)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ride_ratings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id uuid NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  rater_role text NOT NULL CHECK (rater_role IN ('rider', 'driver')),
  stars smallint NOT NULL CHECK (stars BETWEEN 1 AND 5),
  comment text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ride_id, rater_role)
);
CREATE INDEX IF NOT EXISTS idx_ride_ratings_ride ON ride_ratings (ride_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 3. Opriri multiple (opțional; pentru curse cu waypoint-uri)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ride_stops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id uuid NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  seq smallint NOT NULL,
  address text NOT NULL,
  lat double precision NOT NULL,
  lng double precision NOT NULL,
  arrived_at timestamptz,
  UNIQUE (ride_id, seq)
);

COMMIT;
