-- 20260926_0005_archive_fake_data
--
-- Scoate din vizibilitatea publică datele fabricate / de test rămase în producție
-- (audituri 2026-09-25: shop, fly, food, profiles-social, feed-algorithm).
--
-- REGULI: nimic nu se șterge (fără DELETE / DROP). Fiecare rând atins își salvează
-- întâi valorile vechi în `data_cleanup_archive` (prima arhivare câștigă — reluarea
-- migrării nu suprascrie backup-ul), apoi primește un status ne-public pe care
-- interogările publice îl respectă deja:
--   marketplace_products.status = 'archived'  (listări cer status = 'active')
--   videos.is_hidden = true                   (feed/profil cer is_hidden = false)
--   users.status = 'suspended'                (/u/[username] cere status = 'active')
--   local_merchants.status = 'suspended'      (/api/merchants cere status = 'active')
-- Idempotent: predicatele nu depind de coloanele modificate, INSERT-urile au
-- ON CONFLICT DO NOTHING, UPDATE-urile setează aceleași valori.
--
-- REVERSARE (rulează manual, în ordinea asta; restaurează exact valorile vechi):
--   UPDATE marketplace_products t SET status = a.prev->>'status', metadata = a.prev->'metadata'
--     FROM data_cleanup_archive a
--    WHERE a.batch = '20260926_0005' AND a.table_name = 'marketplace_products' AND a.row_id = t.id::text;
--   UPDATE videos t SET is_hidden = (a.prev->>'is_hidden')::boolean,
--          hidden_at = NULLIF(a.prev->>'hidden_at', '')::timestamptz
--     FROM data_cleanup_archive a
--    WHERE a.batch = '20260926_0005' AND a.table_name = 'videos' AND a.row_id = t.id::text;
--   UPDATE users t SET status = a.prev->>'status', suspension_reason = a.prev->>'suspension_reason'
--     FROM data_cleanup_archive a
--    WHERE a.batch = '20260926_0005' AND a.table_name = 'users' AND a.row_id = t.id::text;
--   UPDATE local_merchants t SET status = a.prev->>'status'
--     FROM data_cleanup_archive a
--    WHERE a.batch = '20260926_0005' AND a.table_name = 'local_merchants' AND a.row_id = t.id::text;

BEGIN;

CREATE TABLE IF NOT EXISTS data_cleanup_archive (
  id          bigserial   PRIMARY KEY,
  batch       text        NOT NULL,
  table_name  text        NOT NULL,
  row_id      text        NOT NULL,
  prev        jsonb       NOT NULL,
  reason      text        NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch, table_name, row_id)
);

COMMENT ON TABLE data_cleanup_archive IS
  'Backup al valorilor vechi pentru curățări de date (fake/test) — permite reversarea exactă. Nu șterge rânduri.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Produse marketplace fabricate
--    a) cele 6 „Zbor spre X” din scripts/seed-fly-products.sql (8a16a797, șters
--       din git în 8384daa7): listing_type='listing', metadata.vertical='fly',
--       metadata.fly_iata setat, rating 4.9 inventat, prețuri statice
--       WHERE listing_type = 'listing' AND metadata->>'vertical' = 'fly'
--         AND metadata ? 'fly_iata' AND title LIKE 'Zbor spre %'
--    b) produsul E2E „Smart TV 55" 4K UHD” la 2499,99 RON (docs/REAL_E2E_JOURNAL.md)
--       WHERE listing_type = 'product' AND title ILIKE 'Smart TV 55%' AND price_cents = 249999
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO data_cleanup_archive (batch, table_name, row_id, prev, reason)
SELECT '20260926_0005', 'marketplace_products', p.id::text,
       jsonb_build_object('status', p.status, 'metadata', p.metadata),
       CASE WHEN p.listing_type = 'listing' THEN 'seed_fly_listing_fake_price_rating'
            ELSE 'e2e_test_product' END
  FROM marketplace_products p
 WHERE (p.listing_type = 'listing'
        AND p.metadata->>'vertical' = 'fly'
        AND p.metadata ? 'fly_iata'
        AND p.title LIKE 'Zbor spre %')
    OR (p.listing_type = 'product'
        AND p.title ILIKE 'Smart TV 55%'
        AND p.price_cents = 249999)
ON CONFLICT (batch, table_name, row_id) DO NOTHING;

UPDATE marketplace_products p
   SET status = 'archived',
       -- rating-ul 4.9 era inventat; valoarea veche rămâne în arhivă
       metadata = p.metadata - 'rating',
       updated_at = now()
  FROM data_cleanup_archive a
 WHERE a.batch = '20260926_0005'
   AND a.table_name = 'marketplace_products'
   AND a.row_id = p.id::text;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Conturi creator de test/QA (profiluri publice) — conservator:
--    doar conturi cu marcaje explicite de test ȘI conținut de creator,
--    niciodată admin.
--      username IN ('qacreator2','teo_creator_test','creator_test')
--      OR display_name IN ('Carmen QA Creator','Creator Test QA')
--      OR email se termină în '@swypik.test' / '@test.swypik.local' (domenii E2E)
--    AND (role = 'creator' OR are cel puțin un clip) AND role <> 'admin'
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO data_cleanup_archive (batch, table_name, row_id, prev, reason)
SELECT '20260926_0005', 'users', u.id::text,
       jsonb_build_object('status', u.status, 'suspension_reason', u.suspension_reason),
       'qa_test_creator_account'
  FROM users u
 WHERE (u.username IN ('qacreator2', 'teo_creator_test', 'creator_test')
        OR u.display_name IN ('Carmen QA Creator', 'Creator Test QA')
        OR lower(u.email) LIKE '%@swypik.test'
        OR lower(u.email) LIKE '%@test.swypik.local')
   AND (u.role = 'creator' OR EXISTS (SELECT 1 FROM videos v WHERE v.creator_id = u.id))
   AND u.role <> 'admin'
ON CONFLICT (batch, table_name, row_id) DO NOTHING;

UPDATE users u
   SET status = 'suspended',
       suspension_reason = 'qa_test_account_archived_20260926',
       updated_at = now()
  FROM data_cleanup_archive a
 WHERE a.batch = '20260926_0005'
   AND a.table_name = 'users'
   AND a.row_id = u.id::text;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Clipuri de test ascunse din feed/profil/căutare:
--      clipurile creatorilor de mai sus
--      OR clipuri al căror fișier sursă e un clip QA (video_assets.object_key ILIKE '%qa-clip%',
--         ex. .../raw/.../qa-clip1.mp4 folosit ca video al produsului „Zbor spre Paris”)
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO data_cleanup_archive (batch, table_name, row_id, prev, reason)
SELECT '20260926_0005', 'videos', v.id::text,
       jsonb_build_object('is_hidden', v.is_hidden, 'hidden_at', v.hidden_at),
       'qa_test_video'
  FROM videos v
 WHERE v.creator_id IN (SELECT a.row_id::uuid FROM data_cleanup_archive a
                          WHERE a.batch = '20260926_0005' AND a.table_name = 'users')
    OR EXISTS (SELECT 1 FROM video_assets va
                WHERE va.video_id = v.id AND va.object_key ILIKE '%qa-clip%')
ON CONFLICT (batch, table_name, row_id) DO NOTHING;

UPDATE videos v
   SET is_hidden = true,
       hidden_at = COALESCE(v.hidden_at, now()),
       updated_at = now()
  FROM data_cleanup_archive a
 WHERE a.batch = '20260926_0005'
   AND a.table_name = 'videos'
   AND a.row_id = v.id::text;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Restaurante de test / demo (Food):
--    a) „Restaurantul Țest QA” (slug restaurantul-test-qa-4urs, meniu QATEST)
--       WHERE slug LIKE 'restaurantul-test-qa%' OR name ILIKE 'Restaurantul _est QA%'
--    b) restaurantele demo cu rating inventat (4.89–4.97; nu există recenzii reale
--       pentru restaurante) și poze stoc Unsplash, adăugate manual (nu din OSM):
--       WHERE source = 'manual' AND rating IS NOT NULL AND image_url ILIKE '%unsplash.com%'
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO data_cleanup_archive (batch, table_name, row_id, prev, reason)
SELECT '20260926_0005', 'local_merchants', m.id::text,
       jsonb_build_object('status', m.status, 'rating', m.rating),
       CASE WHEN m.slug LIKE 'restaurantul-test-qa%' OR m.name ILIKE 'Restaurantul _est QA%'
            THEN 'qa_test_restaurant' ELSE 'demo_restaurant_fake_rating' END
  FROM local_merchants m
 WHERE m.slug LIKE 'restaurantul-test-qa%'
    OR m.name ILIKE 'Restaurantul _est QA%'
    OR (m.source = 'manual' AND m.rating IS NOT NULL AND m.image_url ILIKE '%unsplash.com%')
ON CONFLICT (batch, table_name, row_id) DO NOTHING;

UPDATE local_merchants m
   SET status = 'suspended',
       updated_at = now()
  FROM data_cleanup_archive a
 WHERE a.batch = '20260926_0005'
   AND a.table_name = 'local_merchants'
   AND a.row_id = m.id::text;

COMMIT;
