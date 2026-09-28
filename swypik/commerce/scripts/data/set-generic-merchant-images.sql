-- Poze generice per tip de bucătărie pentru profilurile OSM fără imagine.
-- Sursă: images.unsplash.com (licență Unsplash — utilizare liberă).
-- Rulează idempotent: doar unde image_url IS NULL și source='osm'.

WITH img(cuisine, url) AS (
  VALUES
    ('pizza',          'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=800&q=70'),
    ('burger',         'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=800&q=70'),
    ('kebab',          'https://images.unsplash.com/photo-1561651823-34feb02250e4?w=800&q=70'),
    ('fast food',      'https://images.unsplash.com/photo-1552566626-52f8b828add9?w=800&q=70'),
    ('cafenea',        'https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?w=800&q=70'),
    ('cafe',           'https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?w=800&q=70'),
    ('sushi',          'https://images.unsplash.com/photo-1579871494447-9811cf80d66c?w=800&q=70'),
    ('asiatica',       'https://images.unsplash.com/photo-1512058564366-18510be2db19?w=800&q=70'),
    ('italiana',       'https://images.unsplash.com/photo-1551183053-bf91a1d81141?w=800&q=70'),
    ('peste',          'https://images.unsplash.com/photo-1519708227418-c8fd9a32b7a2?w=800&q=70'),
    ('gratar',         'https://images.unsplash.com/photo-1529193591184-b1d58069ecdd?w=800&q=70'),
    ('pui',            'https://images.unsplash.com/photo-1626645738196-c2a7c87a8f58?w=800&q=70'),
    ('patiserie',      'https://images.unsplash.com/photo-1509440159596-0249088772ff?w=800&q=70'),
    ('cofetarie',      'https://images.unsplash.com/photo-1488477181946-6428a0291777?w=800&q=70'),
    ('inghetata',      'https://images.unsplash.com/photo-1497034825429-c343d7c6a68f?w=800&q=70'),
    ('sandvisuri',     'https://images.unsplash.com/photo-1528735602780-2552fd46c7af?w=800&q=70'),
    ('hot dog',        'https://images.unsplash.com/photo-1612392062798-2dbd18f5e9e6?w=800&q=70'),
    ('vegetariana',    'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=800&q=70'),
    ('mexicana',       'https://images.unsplash.com/photo-1565299585323-38d6b0865b47?w=800&q=70'),
    ('turceasca',      'https://images.unsplash.com/photo-1561651823-34feb02250e4?w=800&q=70'),
    ('romaneasca',     'https://images.unsplash.com/photo-1414235077428-338989a2e8c0?w=800&q=70')
)
UPDATE local_merchants m
SET image_url = i.url, updated_at = now()
FROM img i
WHERE m.source = 'osm'
  AND m.image_url IS NULL
  AND i.cuisine = m.cuisine_types[1];

-- fallback pentru orice a rămas fără mapare
UPDATE local_merchants
SET image_url = 'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=800&q=70',
    updated_at = now()
WHERE source = 'osm' AND image_url IS NULL;
