-- ============================================================================
-- Eats checkout — adrese salvate cu coordonate pentru livrare.
--   • user_addresses.lat/lng  → pin exact pe hartă (taxă livrare corectă)
--   • user_addresses.details → instrucțiuni curier (interfon, etaj, reper)
-- Idempotent.
-- ============================================================================
ALTER TABLE user_addresses ADD COLUMN IF NOT EXISTS lat double precision;
ALTER TABLE user_addresses ADD COLUMN IF NOT EXISTS lng double precision;
ALTER TABLE user_addresses ADD COLUMN IF NOT EXISTS details text;
