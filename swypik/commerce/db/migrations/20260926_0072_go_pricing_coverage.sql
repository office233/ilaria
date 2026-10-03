-- Swypik Go — acoperire pricing (audit go.md §2.5). (2026-09-26, w3-go)
--   1. pricing_city_aliases: localitățile care se reverse-geocodează altfel
--      decât zona tarifară (Otopeni = aeroportul Bucureștiului, Voluntari,
--      Pipera, ...) sunt mapate pe orașul zonei. Fără asta: 422 no_zone.
--   2. pricing_zones.max_passengers — capacitatea clasei, afișată pasagerului
--      (înainte hardcodată în client, împreună cu modele de mașini inventate).
-- Nu se inventează tarife noi: clasele fără zonă activă sunt ascunse în UI.
-- Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS pricing_city_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alias text NOT NULL,
  city text NOT NULL,
  country char(2) NOT NULL DEFAULT 'RO',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pricing_city_alias_unique
  ON pricing_city_aliases (lower(alias), country);

INSERT INTO pricing_city_aliases (alias, city, country)
SELECT v.alias, v.city, 'RO'
  FROM (VALUES
    ('Otopeni', 'București'),
    ('Voluntari', 'București'),
    ('Pipera', 'București'),
    ('Chiajna', 'București'),
    ('Bragadiru', 'București'),
    ('Popești-Leordeni', 'București'),
    ('Pantelimon', 'București'),
    ('Mogoșoaia', 'București'),
    ('Chitila', 'București'),
    ('Măgurele', 'București'),
    ('Jilava', 'București'),
    ('Dobroești', 'București'),
    ('Tunari', 'București'),
    ('Corbeanca', 'București'),
    ('Ștefăneștii de Jos', 'București'),
    ('Municipiul București', 'București'),
    ('Sector 1', 'București'),
    ('Sector 2', 'București'),
    ('Sector 3', 'București'),
    ('Sector 4', 'București'),
    ('Sector 5', 'București'),
    ('Sector 6', 'București'),
    ('Florești', 'Cluj-Napoca'),
    ('Apahida', 'Cluj-Napoca'),
    ('Dumbrăvița', 'Timișoara'),
    ('Giroc', 'Timișoara'),
    ('Moșnița Nouă', 'Timișoara'),
    ('Tomești', 'Iași'),
    ('Valea Lupului', 'Iași')
  ) AS v(alias, city)
 WHERE NOT EXISTS (
   SELECT 1 FROM pricing_city_aliases a
    WHERE lower(a.alias) = lower(v.alias) AND a.country = 'RO'
 );

ALTER TABLE pricing_zones ADD COLUMN IF NOT EXISTS max_passengers smallint;

DO $$ BEGIN
  ALTER TABLE pricing_zones ADD CONSTRAINT pricing_zones_max_passengers_chk
    CHECK (max_passengers IS NULL OR max_passengers BETWEEN 1 AND 20);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

UPDATE pricing_zones SET max_passengers = CASE vehicle_class
    WHEN 'van' THEN 6
    WHEN 'bike' THEN 1
    ELSE 4 END
 WHERE max_passengers IS NULL;

COMMIT;
