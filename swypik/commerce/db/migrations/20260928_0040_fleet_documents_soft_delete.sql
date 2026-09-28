-- 20260928_40_fleet_documents_soft_delete
--
-- Audit food-go (2026-09-28):
--  #28 „delete" din /admin/fleet ștergea fizic curierul (FK din rides/local_orders
--      → 500 sau istoric pierdut) → ștergere logică: couriers.deleted_at.
--  #3  documentele șoferilor se încarcă acum în storage (R2) prin
--      POST /api/couriers/documents; cheia obiectului în courier_documents.file_key
--      (file_url rămâne pentru rândurile vechi, din backfill).
-- Idempotent; nu șterge nimic.

BEGIN;

ALTER TABLE couriers ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_couriers_not_deleted ON couriers (verification_status) WHERE deleted_at IS NULL;

ALTER TABLE courier_documents ADD COLUMN IF NOT EXISTS file_key text;
ALTER TABLE courier_documents ADD COLUMN IF NOT EXISTS submitted_at timestamptz;

COMMIT;
