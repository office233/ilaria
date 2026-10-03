-- ============================================================================
-- P0.2 (audit 2026-08-02): FĂRĂ rânduri în pricing_zones, Go și Food delivery
-- dau 422 no_zone la ORICE estimare — verticala e moartă. Seed idempotent cu
-- tarife realiste RON pentru orașul pilot (Satu Mare) + orașe mari.
-- Tarife orientative piață 2026: bază 2.5-3.5 lei, ~2.2-2.9 lei/km.
-- ============================================================================

INSERT INTO pricing_zones
  (city, country, kind, vehicle_class, base_cents, per_km_cents, per_min_cents,
   min_fare_cents, booking_fee_cents, cancel_fee_cents,
   platform_commission_pct, courier_share_pct, currency)
SELECT v.city, 'RO', v.kind, v.vclass, v.base, v.km, v.min,
       v.minfare, v.book, v.cancel, v.plat, v.share, 'RON'
FROM (VALUES
  -- ── Satu Mare (oraș pilot) ──────────────────────────────────────────
  ('Satu Mare', 'ride',     'economy', 250, 220, 30, 800,  100, 500, 20.00, 80.00),
  ('Satu Mare', 'ride',     'comfort', 350, 280, 40, 1000, 100, 700, 20.00, 80.00),
  ('Satu Mare', 'delivery', 'bike',    200, 180, 20, 600,  100, 300, 20.00, 80.00),
  ('Satu Mare', 'delivery', 'economy', 250, 200, 25, 700,  100, 300, 20.00, 80.00),
  ('Satu Mare', 'errand',   'economy', 300, 220, 30, 900,  100, 300, 20.00, 80.00),
  -- ── București ───────────────────────────────────────────────────────
  ('București', 'ride',     'economy', 300, 260, 40, 1000, 150, 700, 20.00, 80.00),
  ('București', 'ride',     'comfort', 450, 330, 55, 1400, 150, 900, 20.00, 80.00),
  ('București', 'delivery', 'bike',    250, 200, 25, 800,  150, 300, 20.00, 80.00),
  ('București', 'delivery', 'economy', 300, 230, 30, 900,  150, 300, 20.00, 80.00),
  -- ── Cluj-Napoca ─────────────────────────────────────────────────────
  ('Cluj-Napoca', 'ride',     'economy', 300, 250, 38, 950, 120, 600, 20.00, 80.00),
  ('Cluj-Napoca', 'delivery', 'bike',    230, 190, 22, 700, 120, 300, 20.00, 80.00),
  -- ── Timișoara ───────────────────────────────────────────────────────
  ('Timișoara', 'ride',     'economy', 280, 240, 35, 900, 120, 600, 20.00, 80.00),
  ('Timișoara', 'delivery', 'bike',    220, 185, 22, 700, 120, 300, 20.00, 80.00),
  -- ── Iași ────────────────────────────────────────────────────────────
  ('Iași', 'ride',     'economy', 280, 235, 35, 900, 120, 600, 20.00, 80.00),
  ('Iași', 'delivery', 'bike',    220, 185, 22, 700, 120, 300, 20.00, 80.00)
) AS v(city, kind, vclass, base, km, min, minfare, book, cancel, plat, share)
WHERE NOT EXISTS (
  SELECT 1 FROM pricing_zones pz
   WHERE lower(pz.city) = lower(v.city) AND pz.country = 'RO'
     AND pz.kind = v.kind AND pz.vehicle_class = v.vclass AND pz.active
);
