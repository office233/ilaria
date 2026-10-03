-- ============================================================================
-- FRONT R3 — Pricing Engine: coloane de trasabilitate pe local_orders
--   Taxa de livrare dinamică e persistată cu breakdown-ul din care a rezultat,
--   ca să poată fi auditată/reconciliată (R5 wallet split).
-- Idempotent.
-- ============================================================================

ALTER TABLE local_orders ADD COLUMN IF NOT EXISTS delivery_distance_km numeric(8,3);
ALTER TABLE local_orders ADD COLUMN IF NOT EXISTS delivery_fee_breakdown jsonb;
ALTER TABLE local_orders ADD COLUMN IF NOT EXISTS surge_multiplier numeric(3,2);
ALTER TABLE local_orders ADD COLUMN IF NOT EXISTS pricing_zone_id uuid REFERENCES pricing_zones(id);
