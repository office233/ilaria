-- ============================================================================
-- FRONT 8 — rezervări pe ore (servicii) + owner pe donation_causes.
-- Idempotent.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- tip range pe time (nu există built-in)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'timerange') THEN
    CREATE TYPE timerange AS RANGE (subtype = time);
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. BOOKING SLOTS — rezervări pe ore (frizerii, service-uri, terenuri etc.)
--    Produsul e un marketplace_product (vertical servicii).
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS booking_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES marketplace_products(id) ON DELETE CASCADE,
  customer_user_id uuid,
  customer_name text NOT NULL,
  customer_phone text,
  customer_email text,
  slot_date date NOT NULL,
  start_time time NOT NULL,
  end_time time NOT NULL CHECK (end_time > start_time),
  price_cents integer NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  currency char(3) NOT NULL DEFAULT 'RON',
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'cancelled', 'completed', 'no_show')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slot_has_contact CHECK (customer_phone IS NOT NULL OR customer_email IS NOT NULL OR customer_user_id IS NOT NULL)
);

-- Fără suprapunere pe același produs + zi (doar rezervări active).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'booking_slots_no_overlap'
  ) THEN
    ALTER TABLE booking_slots
      ADD CONSTRAINT booking_slots_no_overlap
      EXCLUDE USING gist (
        product_id WITH =,
        slot_date WITH =,
        timerange(start_time, end_time) WITH &&
      ) WHERE (status IN ('pending', 'confirmed'));
  END IF;
EXCEPTION WHEN undefined_function THEN
  -- timerange nu există pe versiuni vechi; fallback la unique simplu
  CREATE UNIQUE INDEX IF NOT EXISTS idx_bs_unique_start
    ON booking_slots (product_id, slot_date, start_time)
    WHERE status IN ('pending', 'confirmed');
END $$;

CREATE INDEX IF NOT EXISTS idx_bs_product_day ON booking_slots (product_id, slot_date);
CREATE INDEX IF NOT EXISTS idx_bs_customer ON booking_slots (customer_user_id, slot_date DESC)
  WHERE customer_user_id IS NOT NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. donation_causes.owner_user_id — cine a înregistrat cauza (panou cauze).
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE donation_causes
  ADD COLUMN IF NOT EXISTS owner_user_id uuid;
CREATE INDEX IF NOT EXISTS idx_causes_owner
  ON donation_causes (owner_user_id) WHERE owner_user_id IS NOT NULL;
