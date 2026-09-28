-- 20260926_0032_local_orders_guest_token
--
-- Swypik Food — tracking pentru comenzile fără cont.
-- POST /api/local-orders acceptă comenzi anonime, dar GET /api/local-orders/[id]
-- răspundea 401 oricui nu era logat, deci „Urmărește live" nu funcționa după
-- o comandă guest. Acum la plasare se generează un token aleator (întors o
-- singură dată clientului); în DB stă doar sha256-ul lui.
-- Idempotent; nu șterge nimic.

BEGIN;

ALTER TABLE local_orders
  ADD COLUMN IF NOT EXISTS guest_token_hash text;

COMMIT;
