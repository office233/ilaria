-- 20260926_0033_merchant_city_key_cuisines
--
-- Swypik Food — filtrele din /food erau stricate:
--   * oraș: `location_city ILIKE $1` fără normalizare → „Bucuresti" și
--     „București" erau orașe diferite. Coloană generată `city_key`
--     (fără diacritice, lowercase, trim) + index; oglinda JS: lib/food/city.ts.
--   * bucătărie: chip-urile trimiteau `romanian/asian/burgers`, importul OSM
--     scria `romaneasca/asiatica/burger`. Normalizăm cuisine_types pe id-urile
--     canonice din lib/merchants/cuisines.json (aliasurile necunoscute rămân).
-- Idempotent; nu șterge nimic.

BEGIN;

ALTER TABLE local_merchants
  ADD COLUMN IF NOT EXISTS city_key text
  GENERATED ALWAYS AS (
    lower(btrim(translate(COALESCE(location_city, ''),
      'ĂÂÎȘŞȚŢăâîșşțţÉÈËÊÁÀÄÖÜÓÚÍéèëêáàäöüóúí',
      'AAISSTTaaissttEEEEAAAOUOUIeeeeaaaououi')))
  ) STORED;

CREATE INDEX IF NOT EXISTS local_merchants_city_key_idx
  ON local_merchants (city_key, kind, status);

WITH alias(raw, canon) AS (
  VALUES
    ('pizza', 'pizza'),
    ('pizzeria', 'pizza'),
    ('burgers', 'burgers'),
    ('burger', 'burgers'),
    ('hamburger', 'burgers'),
    ('asian', 'asian'),
    ('asiatica', 'asian'),
    ('chinese', 'asian'),
    ('japanese', 'asian'),
    ('thai', 'asian'),
    ('vietnamese', 'asian'),
    ('korean', 'asian'),
    ('romanian', 'romanian'),
    ('romaneasca', 'romanian'),
    ('regional', 'romanian'),
    ('local', 'romanian'),
    ('traditional', 'romanian'),
    ('desserts', 'desserts'),
    ('dessert', 'desserts'),
    ('cofetarie', 'desserts'),
    ('cake', 'desserts'),
    ('ice_cream', 'desserts'),
    ('inghetata', 'desserts'),
    ('patiserie', 'desserts'),
    ('pastry', 'desserts'),
    ('bakery', 'desserts'),
    ('healthy', 'healthy'),
    ('salad', 'healthy'),
    ('vegetarian', 'healthy'),
    ('vegetariana', 'healthy'),
    ('vegan', 'healthy'),
    ('vegana', 'healthy'),
    ('kebab', 'kebab'),
    ('shaorma', 'kebab'),
    ('doner', 'kebab'),
    ('sushi', 'sushi'),
    ('italian', 'italian'),
    ('italiana', 'italian'),
    ('pasta', 'italian'),
    ('grill', 'grill'),
    ('gratar', 'grill'),
    ('barbecue', 'grill'),
    ('bbq', 'grill'),
    ('fast_food', 'fast_food'),
    ('fast food', 'fast_food'),
    ('sandwich', 'fast_food'),
    ('sandvisuri', 'fast_food'),
    ('chicken', 'fast_food'),
    ('pui', 'fast_food'),
    ('cafe', 'cafe'),
    ('cafenea', 'cafe'),
    ('coffee_shop', 'cafe'),
    ('coffee', 'cafe'),
    ('fish', 'fish'),
    ('peste', 'fish'),
    ('seafood', 'fish'),
    ('turkish', 'turkish'),
    ('turceasca', 'turkish'),
    ('greek', 'greek'),
    ('greceasca', 'greek'),
    ('american', 'american'),
    ('americana', 'american'),
    ('mexican', 'mexican'),
    ('mexicana', 'mexican'),
    ('indian', 'indian'),
    ('indiana', 'indian'),
    ('international', 'international'),
    ('internationala', 'international')
),
normalized AS (
  SELECT m.id,
         ARRAY(
           SELECT DISTINCT COALESCE(a.canon, lower(btrim(c)))
             FROM unnest(m.cuisine_types) AS c
             LEFT JOIN alias a ON a.raw = lower(btrim(c))
         ) AS cuisines
    FROM local_merchants m
   WHERE m.cuisine_types IS NOT NULL AND cardinality(m.cuisine_types) > 0
)
UPDATE local_merchants m
   SET cuisine_types = n.cuisines
  FROM normalized n
 WHERE n.id = m.id
   AND m.cuisine_types IS DISTINCT FROM n.cuisines;

COMMIT;
