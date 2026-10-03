-- 20260730_0003_courier_location_history.sql
-- Istoric GPS curieri. PWA-ul trimite poziția la ~10s prin
-- POST /api/couriers/status; pe lângă UPDATE couriers.current_lat/lng
-- scriem și aici pentru replay traseu / dispute / analytics.
--
-- RETENȚIE: 30 de zile. Adaugă în cron (ex. crontab root sau pg_cron):
--   -- zilnic la 04:15
--   DELETE FROM courier_location_history WHERE recorded_at < now() - interval '30 days';
-- ex. crontab: 15 4 * * * psql "$DATABASE_URL" -c "DELETE FROM courier_location_history WHERE recorded_at < now() - interval '30 days'"

BEGIN;

CREATE TABLE IF NOT EXISTS courier_location_history (
  id          bigserial PRIMARY KEY,
  courier_id  uuid NOT NULL REFERENCES couriers(id) ON DELETE CASCADE,
  lat         double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng         double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  speed_kmh   real,
  heading     real CHECK (heading IS NULL OR (heading >= 0 AND heading < 360)),
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS courier_location_history_courier_idx
  ON courier_location_history (courier_id, recorded_at DESC);

COMMIT;
