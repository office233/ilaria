-- 20260730_0020_fleet_partners.sql
-- Francize de flota: parteneri care administreaza soferi/curieri intr-un oras.
BEGIN;

CREATE TABLE IF NOT EXISTS fleet_partners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  company_name text NOT NULL,
  cui text,
  contact_name text,
  phone text NOT NULL,
  email text,
  city text NOT NULL,
  country char(2) NOT NULL DEFAULT 'RO',
  -- ce vertical opereaza franciza
  vertical text NOT NULL DEFAULT 'both' CHECK (vertical IN ('go', 'food', 'both')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'suspended', 'rejected')),
  commission_bps integer NOT NULL DEFAULT 0 CHECK (commission_bps BETWEEN 0 AND 5000),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fleet_partners_city_idx ON fleet_partners (city, status);
CREATE UNIQUE INDEX IF NOT EXISTS fleet_partners_user_uidx
  ON fleet_partners (user_id) WHERE user_id IS NOT NULL;

-- Soferul/curierul poate apartine unei francize
ALTER TABLE couriers ADD COLUMN IF NOT EXISTS fleet_partner_id uuid REFERENCES fleet_partners(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS couriers_fleet_partner_idx
  ON couriers (fleet_partner_id) WHERE fleet_partner_id IS NOT NULL;

COMMIT;
