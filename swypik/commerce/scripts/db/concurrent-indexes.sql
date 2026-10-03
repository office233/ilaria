-- ============================================================================
-- Indexuri care NU au voie să treacă prin db/migrations/
-- ============================================================================
-- Runner-ul de migrări (scripts/db/apply-migration.sh) împachetează fișierul
-- într-o singură tranzacție, iar `CREATE INDEX CONCURRENTLY` nu poate rula
-- într-un bloc de tranzacție (SQLSTATE 25001). Tabelul `feed_events` e cel mai
-- mare și cel mai scris din sistem (impression + video_view + watch_time la
-- fiecare swipe), deci un CREATE INDEX obișnuit ar bloca scrierile pe toată
-- durata build-ului. De aceea: rulare MANUALĂ, statement cu statement.
--
-- Cum se rulează (fiecare comandă separat, NU cu -f pe tot fișierul):
--   docker exec -i swypik-prod-postgres-1 psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
--     -c "<un singur CREATE INDEX CONCURRENTLY de mai jos>"
--
-- ATENȚIE la re-rulare: dacă un CREATE INDEX CONCURRENTLY eșuează la mijloc,
-- lasă un index INVALID pe care `IF NOT EXISTS` îl sare tăcut la reîncercare —
-- rămâne un index inutilizabil care costă la fiecare scriere. Verifică întâi:
--
--   SELECT c.relname, i.indisvalid
--     FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
--    WHERE c.relname LIKE 'feed_events_%';
--
-- și șterge manual orice rând cu indisvalid = false (DROP INDEX CONCURRENTLY ...)
-- înainte de a reîncerca.
-- ============================================================================

-- Penalizarea de repetiție din /api/explore/feed: „a văzut viewerul acest clip
-- în ultimele 24h?". Indexurile existente feed_events_user_recent_idx
-- (actor_user_id, occurred_at DESC) și feed_events_session_recent_idx
-- (session_id, occurred_at DESC) nu conțin video_id, deci Postgres citește toate
-- evenimentele recente ale viewerului pentru fiecare clip candidat.

CREATE INDEX CONCURRENTLY IF NOT EXISTS feed_events_actor_video_recent_idx
  ON feed_events (actor_user_id, video_id, occurred_at DESC)
  WHERE actor_user_id IS NOT NULL;

-- Geamănul pe sesiune. ExploreClient trimite `session_id` la FIECARE cerere,
-- autentificat sau nu, deci această ramură se execută mai des decât cea logată —
-- fără ea, jumătatea cea mai frecventă a traficului rămâne nereparată.

CREATE INDEX CONCURRENTLY IF NOT EXISTS feed_events_session_video_recent_idx
  ON feed_events (session_id, video_id, occurred_at DESC)
  WHERE session_id IS NOT NULL;

-- ============================================================================
-- OPȚIONAL — sortarea implicită a feed-ului de oferte (orders_count din JSONB).
-- NU rula înainte de verificarea de mai jos: un `::numeric` peste text nevalid
-- oprește build-ul indexului. Rezultatul trebuie să fie 0.
--
--   SELECT count(*) FROM marketplace_products
--    WHERE status='active' AND COALESCE(is_adult,false)=false
--      AND effective_label='safe' AND COALESCE(price_cents,0)>0
--      AND (
--        (NULLIF(metadata->>'orders_count','') IS NOT NULL AND metadata->>'orders_count' !~ '^-?[0-9]+(\.[0-9]+)?$')
--        OR (NULLIF(metadata->>'ae_orders','') IS NOT NULL AND metadata->>'ae_orders' !~ '^-?[0-9]+(\.[0-9]+)?$')
--      );
--
-- Dacă rezultatul NU e 0, feed-ul deja eșuează intermitent pe acele rânduri —
-- curăță datele întâi.
-- ============================================================================
