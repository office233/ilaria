-- 20260926_0062_creator_payout_requests
--
-- Retrageri pentru creatori: aceeași tabelă payout_requests ca la curieri
-- (suma se debitează din portofelul RON la cerere, ref 'payout:{id}'; la
-- respingere se recreditează, ref 'payout_refund:{id}'). Coloana `kind`
-- separă cozile de aprobare din admin; rândurile existente sunt ale curierilor.
-- Idempotent; nimic nu se șterge.

BEGIN;

ALTER TABLE payout_requests
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'courier';

DO $$ BEGIN
  ALTER TABLE payout_requests ADD CONSTRAINT payout_requests_kind_check
    CHECK (kind IN ('courier', 'creator'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_payout_requests_kind_status
  ON payout_requests (kind, status, requested_at);

COMMIT;
