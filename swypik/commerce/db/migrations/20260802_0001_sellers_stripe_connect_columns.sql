-- ============================================================================
-- FIX P1 (testare reală E2E 2026-08-02): /seller/payouts dădea 500 —
-- pagina citește stripe_payouts_enabled/charges/details/requirements de pe
-- sellers, dar coloanele nu au fost adăugate niciodată (migrarea 20260730_0013
-- le-a pus doar pe couriers). Idempotent, aditiv.
-- ============================================================================

BEGIN;

ALTER TABLE sellers
  ADD COLUMN IF NOT EXISTS stripe_payouts_enabled  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stripe_charges_enabled  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stripe_details_submitted boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stripe_requirements     jsonb;

COMMIT;
