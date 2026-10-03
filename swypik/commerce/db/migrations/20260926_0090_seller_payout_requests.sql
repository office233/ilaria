-- 20260926_0090_seller_payout_requests
--
-- Retrageri pentru selleri în aceeași tabelă ca pentru curieri/creatori
-- (payout_requests, kind = 'seller'). Sellerii NU sunt rânduri `users`, deci
-- rândul poartă `seller_id` și `user_id` rămâne NULL (cozile courier/creator
-- caută după user_id și nu văd cererile de seller).
--
-- Soldul unui seller nu e în portofelul RON: e suma `seller_payout_cents` din
-- commerce_order_items (după fereastra de retur). La cerere, item-urile eligibile
-- trec în `seller_payout_status = 'requested'` cu `seller_payout_request_id`,
-- ca să nu poată fi cerute de două ori nici plătite de cronul Stripe Connect.
--
-- Idempotent; nimic nu se șterge. `user_id` devine NULLABLE doar pentru kind='seller'
-- (constrângerea de mai jos îl cere în continuare pentru courier/creator).

BEGIN;

ALTER TABLE payout_requests
  ADD COLUMN IF NOT EXISTS seller_id uuid REFERENCES sellers(id) ON DELETE CASCADE;

ALTER TABLE payout_requests ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE payout_requests DROP CONSTRAINT IF EXISTS payout_requests_kind_check;
ALTER TABLE payout_requests ADD CONSTRAINT payout_requests_kind_check
  CHECK (kind IN ('courier', 'creator', 'seller'));

DO $$ BEGIN
  ALTER TABLE payout_requests ADD CONSTRAINT payout_requests_owner_check
    CHECK (
      (kind = 'seller' AND seller_id IS NOT NULL AND user_id IS NULL)
      OR (kind <> 'seller' AND user_id IS NOT NULL)
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- O singură cerere deschisă per seller (gardă la nivel de DB pentru cereri concurente).
CREATE UNIQUE INDEX IF NOT EXISTS uq_payout_requests_seller_open
  ON payout_requests (seller_id)
  WHERE kind = 'seller' AND status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS idx_payout_requests_seller
  ON payout_requests (seller_id, requested_at DESC)
  WHERE seller_id IS NOT NULL;

COMMIT;
