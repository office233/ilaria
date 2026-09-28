-- ============================================================================
-- Migration: 20260824_0002_hot_path_indexes
-- Description: Indexuri lipsă pe două căi fierbinți, identificate în auditul de
--              performanță din 2026-08-24 și confirmate contra indexurilor deja
--              existente (nu duplică nimic din migrările anterioare).
--
-- DE CE FĂRĂ `CONCURRENTLY`: runner-ul proiectului (scripts/db/apply-migration.sh
-- și apply-migration.mjs) trimite fișierul într-o singură tranzacție, iar
-- CREATE INDEX CONCURRENTLY nu poate rula într-un bloc de tranzacție
-- (SQLSTATE 25001) — migrarea ar eșua integral. Ambele tabele de aici sunt mici
-- (~14k produse, comentarii per clip), deci build-ul durează zeci de ms sub lock
-- SHARE (blochează scrierile, nu și citirile).
--
-- Indexurile pe `feed_events` (tabel mare, scriere intensă) NU sunt aici:
-- vezi scripts/db/concurrent-indexes.sql, care trebuie rulat manual, în afara
-- oricărei tranzacții.
-- ============================================================================

BEGIN;

-- 1) Lista + COUNT-ul de comentarii top-level (fiecare deschidere a sheet-ului
--    de comentarii). `comments_video_created_at_idx` există, dar nu filtrează
--    parent/status, deci se scanau și reply-urile (tipic 2-5× mai numeroase) și
--    comentariile ascunse de moderare. Predicatul parțial e identic textual cu
--    WHERE-ul din app/api/videos/[id]/comments/route.ts.
CREATE INDEX IF NOT EXISTS comments_video_toplevel_visible_idx
  ON comments (video_id, created_at DESC)
  WHERE parent_comment_id IS NULL AND status = 'visible';

-- 2) Sortarea „cele mai noi" pe catalog (lib/db/product-queries.ts). Singurul
--    index pe created_at avea predicatul EXACT invers (is_adult = true), deci
--    era inutilizabil aici. Predicatul trebuie să rămână identic textual cu
--    buildSearchFilters: Postgres nu poate deduce că
--    COALESCE(is_adult,false)=false implică is_adult=false.
CREATE INDEX IF NOT EXISTS marketplace_products_active_recent_idx
  ON marketplace_products (created_at DESC)
  WHERE status = 'active'
    AND COALESCE(is_adult, false) = false
    AND effective_label = 'safe'
    AND COALESCE(price_cents, 0) > 0;

ANALYZE comments;
ANALYZE marketplace_products;

INSERT INTO schema_migrations (version)
VALUES ('20260824_0002_hot_path_indexes')
ON CONFLICT (version) DO NOTHING;

COMMIT;
