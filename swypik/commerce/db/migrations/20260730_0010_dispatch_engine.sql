-- ────────────────────────────────────────────────────────────────────────────
-- Dispatch Engine v2 — joburi generice (delivery + ride), valuri cu rază
-- crescătoare (2 → 5 → 10 km), auto-dispatch configurabil per merchant.
-- ────────────────────────────────────────────────────────────────────────────

-- 1. Joburi de dispatch: un job per comandă/cursă activă.
CREATE TABLE IF NOT EXISTS dispatch_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL DEFAULT 'delivery' CHECK (kind IN ('delivery', 'ride')),
  order_id uuid REFERENCES local_orders(id) ON DELETE CASCADE,
  ride_id uuid REFERENCES rides(id) ON DELETE CASCADE,
  city text NOT NULL,
  pickup_lat double precision,
  pickup_lng double precision,
  status text NOT NULL DEFAULT 'searching' CHECK (status IN (
    'searching',   -- caută curier (valuri active)
    'assigned',    -- curier atribuit
    'no_courier',  -- epuizate 3 valuri fără accept
    'cancelled'    -- anulat manual
  )),
  wave integer NOT NULL DEFAULT 0,          -- valul curent (0,1,2)
  assigned_courier_id uuid REFERENCES couriers(id),
  assigned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (order_id IS NOT NULL OR ride_id IS NOT NULL)
);
-- un singur job activ per comandă / cursă
CREATE UNIQUE INDEX IF NOT EXISTS idx_dj_active_order ON dispatch_jobs (order_id)
  WHERE order_id IS NOT NULL AND status IN ('searching', 'assigned');
CREATE UNIQUE INDEX IF NOT EXISTS idx_dj_active_ride ON dispatch_jobs (ride_id)
  WHERE ride_id IS NOT NULL AND status IN ('searching', 'assigned');
CREATE INDEX IF NOT EXISTS idx_dj_searching ON dispatch_jobs (status) WHERE status = 'searching';

-- 2. dispatch_offers: legătură la job + valul în care a fost emisă oferta.
ALTER TABLE dispatch_offers ALTER COLUMN order_id DROP NOT NULL;
ALTER TABLE dispatch_offers ADD COLUMN IF NOT EXISTS job_id uuid REFERENCES dispatch_jobs(id) ON DELETE CASCADE;
ALTER TABLE dispatch_offers ADD COLUMN IF NOT EXISTS wave integer NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS idx_do_job_courier ON dispatch_offers (job_id, courier_id)
  WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_do_job_pending ON dispatch_offers (job_id)
  WHERE response IS NULL;
CREATE INDEX IF NOT EXISTS idx_do_expiring ON dispatch_offers (expires_at)
  WHERE response IS NULL;

-- 3. Auto-dispatch per merchant: când se pornește căutarea curierului.
ALTER TABLE local_merchants ADD COLUMN IF NOT EXISTS auto_dispatch_on text NOT NULL DEFAULT 'ready'
  CHECK (auto_dispatch_on IN ('placed', 'ready', 'manual'));
