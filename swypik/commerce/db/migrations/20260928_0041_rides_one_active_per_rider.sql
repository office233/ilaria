-- 20260928_41_rides_one_active_per_rider
--
-- Audit food-go #13: verificarea „o singură cursă activă per rider" nu era
-- atomică — un dublu-tap crea două curse. Ruta POST /api/rides serializează acum
-- cererile cu pg_advisory_xact_lock; indexul unic parțial de mai jos e plasa de
-- siguranță în baza de date.
--
-- Dacă există deja riders cu mai multe curse active (date istorice), indexul NU
-- se creează (fără anulări automate) — se afișează un NOTICE; după curățarea
-- manuală, migrarea se poate rula din nou (e idempotentă).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM rides
     WHERE rider_user_id IS NOT NULL AND status NOT IN ('completed', 'cancelled')
     GROUP BY rider_user_id HAVING count(*) > 1
  ) THEN
    RAISE NOTICE 'rides_one_active_per_rider: există curse active duplicate — indexul nu a fost creat';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS rides_one_active_per_rider
      ON rides (rider_user_id)
      WHERE rider_user_id IS NOT NULL AND status NOT IN ('completed', 'cancelled');
  END IF;
END $$;
