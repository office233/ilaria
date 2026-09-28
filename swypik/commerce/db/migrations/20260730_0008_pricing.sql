-- ============================================================================
-- FRONT R3 — Pricing Engine: zone tarifare + reguli de surge
-- Idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS pricing_zones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city text NOT NULL,
  country char(2) NOT NULL DEFAULT 'RO',
  kind text NOT NULL CHECK (kind IN ('delivery', 'ride', 'errand')),
  vehicle_class text NOT NULL DEFAULT 'economy'
    CHECK (vehicle_class IN ('economy', 'comfort', 'van', 'bike')),
  base_cents integer NOT NULL CHECK (base_cents >= 0),
  per_km_cents integer NOT NULL CHECK (per_km_cents >= 0),
  per_min_cents integer NOT NULL DEFAULT 0 CHECK (per_min_cents >= 0),
  min_fare_cents integer NOT NULL DEFAULT 0 CHECK (min_fare_cents >= 0),
  booking_fee_cents integer NOT NULL DEFAULT 0 CHECK (booking_fee_cents >= 0),
  cancel_fee_cents integer NOT NULL DEFAULT 0 CHECK (cancel_fee_cents >= 0),
  platform_commission_pct numeric(5,2) NOT NULL DEFAULT 20.00
    CHECK (platform_commission_pct >= 0 AND platform_commission_pct <= 100),
  courier_share_pct numeric(5,2) NOT NULL DEFAULT 80.00
    CHECK (courier_share_pct >= 0 AND courier_share_pct <= 100),
  currency char(3) NOT NULL DEFAULT 'RON',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- o singură zonă activă per (oraș, țară, tip serviciu, clasă vehicul)
CREATE UNIQUE INDEX IF NOT EXISTS idx_pz_unique_active
  ON pricing_zones (lower(city), country, kind, vehicle_class) WHERE active;
CREATE INDEX IF NOT EXISTS idx_pz_lookup ON pricing_zones (lower(city), country, kind) WHERE active;

CREATE TABLE IF NOT EXISTS surge_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  zone_id uuid NOT NULL REFERENCES pricing_zones(id) ON DELETE CASCADE,
  multiplier numeric(3,2) NOT NULL CHECK (multiplier >= 1.00 AND multiplier <= 2.00),
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz,
  auto boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sr_zone_window ON surge_rules (zone_id, starts_at, ends_at);

-- ────────────────────────────────────────────────────────────────────────────
-- Seed oraș pilot: București (valori realiste RON, în cents)
-- ────────────────────────────────────────────────────────────────────────────
INSERT INTO pricing_zones
  (city, country, kind, vehicle_class, base_cents, per_km_cents, per_min_cents,
   min_fare_cents, booking_fee_cents, cancel_fee_cents,
   platform_commission_pct, courier_share_pct, currency, active)
SELECT * FROM (VALUES
  -- livrare food: bază 5 RON + 1.5 RON/km, min 8 RON
  ('București', 'RO', 'delivery', 'bike',    500, 150,  20,  800, 100, 300, 20.00, 80.00, 'RON', true),
  ('București', 'RO', 'delivery', 'economy', 600, 180,  25, 1000, 100, 300, 20.00, 80.00, 'RON', true),
  -- curse: bază 6 RON + 2.2 RON/km + 0.4 RON/min, min 12 RON
  ('București', 'RO', 'ride', 'economy',     600, 220,  40, 1200, 150, 500, 20.00, 80.00, 'RON', true),
  ('București', 'RO', 'ride', 'comfort',     900, 300,  55, 1800, 150, 700, 20.00, 80.00, 'RON', true),
  ('București', 'RO', 'ride', 'van',        1200, 380,  70, 2500, 200, 900, 20.00, 80.00, 'RON', true),
  -- comisioane/errands
  ('București', 'RO', 'errand', 'bike',      700, 200,  30, 1200, 100, 300, 22.00, 78.00, 'RON', true)
) AS seed(city, country, kind, vehicle_class, base_cents, per_km_cents, per_min_cents,
          min_fare_cents, booking_fee_cents, cancel_fee_cents,
          platform_commission_pct, courier_share_pct, currency, active)
WHERE NOT EXISTS (
  SELECT 1 FROM pricing_zones pz
   WHERE lower(pz.city) = lower(seed.city) AND pz.country = seed.country
     AND pz.kind = seed.kind AND pz.vehicle_class = seed.vehicle_class
);
