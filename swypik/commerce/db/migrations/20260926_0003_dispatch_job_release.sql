-- Dispatch: eliberarea jobului + prospețimea curierilor (2026-09-26, w1-security).
--   1. dispatch_jobs primește statusul 'completed' (livrare/cursă finalizată).
--      Înainte, după prima livrare Food jobul rămânea 'assigned' pe veci și
--      curierul nu mai primea oferte (emitWaveOffers/acceptOffer îl vedeau ocupat).
--   2. Reparare date: joburi 'assigned'/'searching' ale căror comenzi/curse
--      sunt deja livrate/anulate → completed/cancelled; ofertele lor pending → expired.
--   3. couriers.last_heartbeat_at — actualizat la fiecare POST /api/couriers/status
--      (cu sau fără GPS); sweep-ul din dispatch-tick pune offline curierii fără heartbeat.
--   4. Curierii suspendați (active=false) nu rămân online.
-- Constrângerea CHECK e recreată (lărgită) — nu se șterg date. Idempotent.

BEGIN;

ALTER TABLE dispatch_jobs DROP CONSTRAINT IF EXISTS dispatch_jobs_status_check;
ALTER TABLE dispatch_jobs ADD CONSTRAINT dispatch_jobs_status_check
  CHECK (status IN ('searching', 'assigned', 'no_courier', 'cancelled', 'completed'));

UPDATE dispatch_jobs j
   SET status = CASE WHEN lo.status = 'delivered' THEN 'completed' ELSE 'cancelled' END,
       updated_at = now()
  FROM local_orders lo
 WHERE j.order_id = lo.id
   AND j.status IN ('searching', 'assigned')
   AND lo.status IN ('delivered', 'cancelled', 'rejected');

UPDATE dispatch_jobs j
   SET status = CASE WHEN r.status = 'completed' THEN 'completed' ELSE 'cancelled' END,
       updated_at = now()
  FROM rides r
 WHERE j.ride_id = r.id
   AND j.status IN ('searching', 'assigned')
   AND r.status IN ('completed', 'cancelled');

UPDATE dispatch_offers o
   SET response = 'expired', responded_at = now()
  FROM dispatch_jobs j
 WHERE o.job_id = j.id
   AND o.response IS NULL
   AND j.status NOT IN ('searching', 'assigned');

ALTER TABLE couriers ADD COLUMN IF NOT EXISTS last_heartbeat_at timestamptz;

UPDATE couriers SET is_online = false, updated_at = now()
 WHERE is_online AND active = false;

CREATE INDEX IF NOT EXISTS idx_couriers_online_heartbeat
  ON couriers (last_heartbeat_at)
  WHERE is_online;

COMMIT;
