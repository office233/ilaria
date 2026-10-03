-- 20260927_0030_perf_indexes
--
-- Indexuri lipsă pe căile de citire fierbinți (audit w6-performance). Fiecare
-- index servește un predicat folosit de un hot path care NU avea niciun index
-- potrivit (verificat cu EXPLAIN ANALYZE pe schema migrată + date sintetice:
-- înainte = Seq Scan repetat per rând, după = Index Scan).
--
-- Idempotent (CREATE INDEX IF NOT EXISTS). Fără BEGIN/COMMIT: se aplică prin
-- scripts/db/apply-migration.sh, care învelește fișierul într-o tranzacție.
-- Fără CONCURRENTLY (nu merge în tranzacție). Pe o tabelă mare, dacă blocarea
-- scrierilor e o problemă, rulați manual înainte de deploy aceleași comenzi cu
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS, în afara tranzacției.
--
-- Rollback:
--   DROP INDEX IF EXISTS users_not_active_id_idx;
--   DROP INDEX IF EXISTS music_unlocks_track_recent_idx;
--   DROP INDEX IF EXISTS movie_unlocks_series_recent_idx;
--   DROP INDEX IF EXISTS movie_watch_progress_episode_recent_idx;

-- Feed (toate sursele de candidați, keyset, hidratare): lib/feed/visibility.ts
-- visibleVideoSql() → NOT EXISTS (SELECT 1 FROM users cu WHERE cu.id = v.creator_id
-- AND COALESCE(cu.status, 'active') <> 'active'). Fără index, fiecare interogare
-- de candidați (7 per pagină For You) face Seq Scan pe toată tabela users ca să
-- construiască hash-ul anti-join. Indexul parțial conține doar conturile
-- suspendate/inactive (puține) — predicatul e identic cu cel din query.
CREATE INDEX IF NOT EXISTS users_not_active_id_idx
  ON users (id)
  WHERE COALESCE(status, 'active') <> 'active';

-- Muzică trending: lib/music/repository.ts listTracks (sort trending) →
-- (SELECT COUNT(*) FROM music_unlocks u WHERE u.track_id = t.id AND u.created_at > now() - 7 days)
-- evaluat pentru FIECARE piesă publicată. Singurul index cu track_id era
-- uq_music_unlocks_track (user_id, track_id) — coloana de conducere greșită.
CREATE INDEX IF NOT EXISTS music_unlocks_track_recent_idx
  ON music_unlocks (track_id, created_at DESC)
  WHERE track_id IS NOT NULL;

-- Filme trending (/api/movies/home): lib/movies/repository.ts listPublishedSeries →
-- (SELECT COUNT(*) FROM movie_unlocks u WHERE u.series_id = s.id AND u.created_at > now() - 7 days)
-- per serial. Existau doar (user_id, series_id) și (user_id, episode_id).
CREATE INDEX IF NOT EXISTS movie_unlocks_series_recent_idx
  ON movie_unlocks (series_id, created_at DESC);

-- Același ORDER BY: movie_watch_progress p JOIN movie_episodes e ON e.id = p.episode_id
-- WHERE e.series_id = s.id AND p.updated_at > now() - 7 days. PK-ul e (user_id, episode_id),
-- deci căutarea după episode_id făcea Seq Scan pe tot progresul, o dată per serial.
CREATE INDEX IF NOT EXISTS movie_watch_progress_episode_recent_idx
  ON movie_watch_progress (episode_id, updated_at DESC);
