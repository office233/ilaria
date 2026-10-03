-- 20260928_43_osm_merchants_no_stock_photos
--
-- Audit food-go #26: profilurile importate din OpenStreetMap (nerevendicate)
-- afișau poze stoc Unsplash alese după bucătărie, ca și cum ar fi pozele
-- restaurantului. Le scoatem: UI-ul arată un placeholder generic (iconița
-- bucătăriei) până când proprietarul revendică profilul și își pune poza.
-- Nu atinge profilurile revendicate (seller_id) sau pozele reale (OSM image/wikimedia).
-- Idempotent.

UPDATE local_merchants
   SET image_url = NULL, updated_at = now()
 WHERE source = 'osm'
   AND seller_id IS NULL
   AND image_url ILIKE '%unsplash.com%';
