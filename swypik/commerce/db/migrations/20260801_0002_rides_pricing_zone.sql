-- ============================================================================
-- FIX R5: rides.pricing_zone_id lipsea — settleRide face JOIN pe ea pentru
-- split-ul platform/curier per zonă (migrarea 0009 acoperea doar local_orders).
-- Aplicată manual în prod pe 2026-08-01; aici pentru medii noi. Idempotent.
-- ============================================================================

ALTER TABLE rides ADD COLUMN IF NOT EXISTS pricing_zone_id uuid REFERENCES pricing_zones(id);
CREATE INDEX IF NOT EXISTS idx_rides_pricing_zone ON rides(pricing_zone_id) WHERE pricing_zone_id IS NOT NULL;
