-- 20260926_0006_merchant_listing_mode
--
-- Profilurile de restaurant nerevendicate (importate din OpenStreetMap, fără
-- proprietar) NU mai pot fi comandate: apar doar ca „sugerează proprietarului”.
--   listing_mode = 'orderable'    → partener Swypik, meniu comandabil
--   listing_mode = 'suggest_only' → profil nerevendicat, fără comenzi
--
-- Default 'suggest_only': un rând nou fără proprietar (import OSM, /food/aplica
-- aprobat fără seller) nu devine comandabil din greșeală. POST /api/merchants
-- (seller autentificat) setează explicit 'orderable'. POST /api/local-orders
-- refuză comenzile când listing_mode <> 'orderable'.
--
-- Backfill: coloana nouă pornește „suggest_only” pe toate rândurile; devin
-- comandabili doar comercianții cu proprietar (seller_id IS NOT NULL).
-- Idempotent; nimic nu se șterge.
-- Reversare: ALTER TABLE local_merchants DROP COLUMN listing_mode; (doar cu backup)

BEGIN;

ALTER TABLE local_merchants
  ADD COLUMN IF NOT EXISTS listing_mode text NOT NULL DEFAULT 'suggest_only';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'local_merchants_listing_mode_check'
  ) THEN
    ALTER TABLE local_merchants
      ADD CONSTRAINT local_merchants_listing_mode_check
      CHECK (listing_mode IN ('orderable', 'suggest_only'));
  END IF;
END $$;

UPDATE local_merchants
   SET listing_mode = 'orderable'
 WHERE seller_id IS NOT NULL
   AND listing_mode <> 'orderable';

CREATE INDEX IF NOT EXISTS local_merchants_listing_mode_idx
  ON local_merchants (listing_mode, status);

COMMIT;
