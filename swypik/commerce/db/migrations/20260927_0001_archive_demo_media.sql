-- 20260927_0001_archive_demo_media
--
-- Trecerea media pe Cloudflare R2 (bucket NOU, gol) + CDN (docs/infra/r2.md).
-- Decizia ownerului: toată media existentă e demo și NU se migrează. Ca după
-- cutover să nu rămână în producție media ruptă:
--   1. TOATE clipurile existente → videos.is_hidden = true (feed/profil/căutare
--      cer is_hidden = false);
--   2. serialele Movies, albumele și piesele Music existente → status 'archived'
--      (fișierele lor sunt în storage-ul vechi);
--   3. orice URL de media stocat care indică storage-ul vechi (MinIO / tunelul
--      cdn.swypik.com / domeniul media vechi / proxy-ul Caddy `/media/`) → NULL,
--      în coloanele text nullable cu nume de media (avatar_url, cover_url,
--      image_url, thumbnail_url, public_url, …) — UI-ul cade pe avatarul /
--      imaginea implicită. Coloanele JSONB (ex. metadata.images) NU se ating.
--
-- REGULI: nimic nu se șterge (fără DELETE / DROP). Fiecare valoare atinsă e
-- salvată întâi în `data_cleanup_archive` (batch '20260927_0001'; pentru URL-uri
-- table_name = '<tabel>.<coloană>'). ONE-SHOT și idempotentă: prima rulare
-- scrie un marcaj (table_name '_run'); orice rulare ulterioară nu mai face
-- nimic, deci nu poate ascunde/goli media încărcată DUPĂ cutover pe R2.
--
-- REVERSARE (manual, restaurează exact valorile vechi):
--   UPDATE videos t SET is_hidden = (a.prev->>'is_hidden')::boolean,
--          hidden_at = NULLIF(a.prev->>'hidden_at', '')::timestamptz
--     FROM data_cleanup_archive a
--    WHERE a.batch = '20260927_0001' AND a.table_name = 'videos' AND a.row_id = t.id::text;
--   UPDATE movie_series t SET status = a.prev->>'status' FROM data_cleanup_archive a
--    WHERE a.batch = '20260927_0001' AND a.table_name = 'movie_series' AND a.row_id = t.id::text;
--   (la fel pentru music_albums, music_tracks)
--   URL-uri, pentru fiecare <tabel>.<coloană> din arhivă (cheia primară = row_id):
--   UPDATE users t SET avatar_url = a.prev->>'avatar_url' FROM data_cleanup_archive a
--    WHERE a.batch = '20260927_0001' AND a.table_name = 'users.avatar_url' AND a.row_id = t.id::text;
--   Lista coloanelor atinse:
--   SELECT table_name, count(*) FROM data_cleanup_archive WHERE batch = '20260927_0001' GROUP BY 1;

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

DO $migration$
DECLARE
  v_batch    CONSTANT text := '20260927_0001';
  -- Host-urile storage-ului vechi (MinIO local/Docker, tunelul CF → MinIO,
  -- domeniul media vechi) și calea relativă a proxy-ului Caddy.
  v_old_host CONSTANT text :=
    '^((https?:)?//(cdn\.swypik\.com|media\.swypik\.com|(swypik-)?minio(:[0-9]+)?|localhost:9000|127\.0\.0\.1:9000)(/|$)|/media/)';
  v_media_col   CONSTANT text := '(url|image|avatar|banner|cover|poster|thumbnail|logo|photo|picture)';
  v_non_media   CONSTANT text :=
    '(website|success|cancel|tracking|affiliate|erp_api|feed_url|destination|action_url|referrer|onboarding|product_url|offer_url|embed|explorer|rtmp|callback|redirect|webhook|return_url|original_url|source_url|external_url|link|doc_url|proof_url)';
  col        record;
  v_tbl      text;
  v_pk       text[];
  v_count    bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM data_cleanup_archive WHERE batch = v_batch AND table_name = '_run') THEN
    RAISE NOTICE '20260927_0001: deja aplicată — nu se atinge nimic';
    RETURN;
  END IF;

  -- 1. Toate clipurile existente → ascunse.
  INSERT INTO data_cleanup_archive (batch, table_name, row_id, prev, reason)
  SELECT v_batch, 'videos', v.id::text,
         jsonb_build_object('is_hidden', v.is_hidden, 'hidden_at', v.hidden_at),
         'demo_media_before_r2_cutover'
    FROM videos v
  ON CONFLICT (batch, table_name, row_id) DO NOTHING;

  UPDATE videos v
     SET is_hidden = true,
         hidden_at = COALESCE(v.hidden_at, now()),
         updated_at = now()
    FROM data_cleanup_archive a
   WHERE a.batch = v_batch AND a.table_name = 'videos' AND a.row_id = v.id::text;

  -- 2. Movies / Music: conținutul existent → arhivat.
  FOREACH v_tbl IN ARRAY ARRAY['movie_series', 'music_albums', 'music_tracks'] LOOP
    IF to_regclass(format('public.%I', v_tbl)) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format(
      'INSERT INTO data_cleanup_archive (batch, table_name, row_id, prev, reason)
       SELECT $1, $2, t.id::text, jsonb_build_object(''status'', t.status), ''demo_media_before_r2_cutover''
         FROM public.%I t WHERE t.status <> ''archived''
       ON CONFLICT (batch, table_name, row_id) DO NOTHING', v_tbl)
      USING v_batch, v_tbl;
    EXECUTE format(
      'UPDATE public.%I t SET status = ''archived'', updated_at = now()
         FROM data_cleanup_archive a
        WHERE a.batch = $1 AND a.table_name = $2 AND a.row_id = t.id::text', v_tbl)
      USING v_batch, v_tbl;
  END LOOP;

  -- 3. URL-uri de media spre storage-ul vechi → NULL (cu backup).
  FOR col IN
    SELECT c.table_name, c.column_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = 'public'
       AND t.table_type = 'BASE TABLE'
       AND c.data_type IN ('text', 'character varying')
       AND c.is_nullable = 'YES'
       AND c.column_name ~ v_media_col
       AND c.column_name !~ v_non_media
       AND c.table_name NOT IN ('data_cleanup_archive', 'schema_migrations')
     ORDER BY c.table_name, c.column_name
  LOOP
    SELECT array_agg(a.attname::text ORDER BY a.attnum) INTO v_pk
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
     WHERE i.indrelid = format('public.%I', col.table_name)::regclass AND i.indisprimary;
    IF v_pk IS NULL OR array_length(v_pk, 1) <> 1 THEN
      RAISE NOTICE '20260927_0001: %.% sărit (fără cheie primară simplă)', col.table_name, col.column_name;
      CONTINUE;
    END IF;

    EXECUTE format(
      'INSERT INTO data_cleanup_archive (batch, table_name, row_id, prev, reason)
       SELECT $1, $2, t.%1$I::text, jsonb_build_object(%3$L, t.%3$I), ''old_storage_media_url''
         FROM public.%2$I t WHERE t.%3$I ~* $3
       ON CONFLICT (batch, table_name, row_id) DO NOTHING',
      v_pk[1], col.table_name, col.column_name)
      USING v_batch, col.table_name || '.' || col.column_name, v_old_host;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count > 0 THEN
      EXECUTE format(
        'UPDATE public.%2$I t SET %3$I = NULL
           FROM data_cleanup_archive a
          WHERE a.batch = $1 AND a.table_name = $2 AND a.row_id = t.%1$I::text',
        v_pk[1], col.table_name, col.column_name)
        USING v_batch, col.table_name || '.' || col.column_name;
      RAISE NOTICE '20260927_0001: %.% → % URL-uri golite', col.table_name, col.column_name, v_count;
    END IF;
  END LOOP;

  INSERT INTO data_cleanup_archive (batch, table_name, row_id, prev, reason)
  VALUES (v_batch, '_run', 'marker', jsonb_build_object('applied_at', now()), 'one_shot_marker')
  ON CONFLICT (batch, table_name, row_id) DO NOTHING;
END
$migration$;

COMMIT;
