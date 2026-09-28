-- Founding Drivers: comisioane pe trepte + promo 0% 60 zile + referral șofer→client
-- Trepte: founding15 (primii 500, 15% pe viață, condiție 50 curse/90 zile),
--         early18 (următorii 2000, 18%), standard20 (20%).

ALTER TABLE couriers ADD COLUMN IF NOT EXISTS commission_tier text
  CHECK (commission_tier IN ('founding15','early18','standard20'));
ALTER TABLE couriers ADD COLUMN IF NOT EXISTS tier_assigned_at timestamptz;
ALTER TABLE couriers ADD COLUMN IF NOT EXISTS promo_zero_until timestamptz;
ALTER TABLE couriers ADD COLUMN IF NOT EXISTS tier_activity_deadline timestamptz;
ALTER TABLE couriers ADD COLUMN IF NOT EXISTS tier_rides_count integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_couriers_commission_tier ON couriers (commission_tier) WHERE commission_tier IS NOT NULL;

CREATE TABLE IF NOT EXISTS platform_config (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO platform_config (key, value) VALUES
  ('founding_slots_total', '500'::jsonb),
  ('early_slots_total', '2000'::jsonb)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS driver_referral_codes (
  courier_id uuid PRIMARY KEY REFERENCES couriers(id) ON DELETE CASCADE,
  code text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS driver_referred_users (
  user_id uuid PRIMARY KEY,
  courier_id uuid NOT NULL REFERENCES couriers(id) ON DELETE CASCADE,
  code text NOT NULL,
  first_ride_bonus_paid boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_driver_referred_users_courier ON driver_referred_users (courier_id);
