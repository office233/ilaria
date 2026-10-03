-- 20260928_0062_payout_requests_user_open_unique
--
-- O singură cerere de retragere deschisă per utilizator (creator/curier), la
-- nivel de DB — pereche cu uq_payout_requests_seller_open (migrarea 0090).
-- Fără index, două POST /api/creator/payouts concurente treceau amândouă de
-- `WHERE NOT EXISTS` și debitau de două ori. lib/creator/payouts.ts folosește
-- `ON CONFLICT DO NOTHING`, deci perdantul primește `open_request_exists`.
--
-- Idempotent. Dacă există deja duplicate istorice deschise, indexul e sărit
-- (NOTICE) — trebuie rezolvate manual din /admin/creator-payouts, apoi rerulat.

DO $$
BEGIN
  BEGIN
    CREATE UNIQUE INDEX IF NOT EXISTS uq_payout_requests_user_open
      ON payout_requests (user_id)
      WHERE kind <> 'seller' AND user_id IS NOT NULL AND status IN ('pending', 'processing');
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'uq_payout_requests_user_open skipped: duplicate open payout requests';
  END;
END $$;
