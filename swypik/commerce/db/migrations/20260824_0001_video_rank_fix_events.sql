-- ============================================================================
-- Migration: 20260824_0001_video_rank_fix_events
-- Description: AUDIT FIX pentru video_rank_14d (ranking-ul real al feed-ului):
--   1. Termenul RE-WATCH numara 'view' — tip care nu exista (clientul emite
--      'video_view', iar 'view' nici nu trece de CHECK-ul din 20260514_0001)
--      => semnalul era 0 pe veci. Corectat la 'video_view' + integrat noul
--      eveniment explicit 'rewatch' (emis de player la bucla 2+).
--   2. UNLIKE nu se scadea niciodata: un like retras ramanea numarat.
--      Acum: GREATEST(likeri distincti - unlikeri distincti, 0).
--   3. Anti-frauda pierduta la rescrierea din 20260811_0001: expresia inline
--      din explore/feed numara semnalele puternice DOAR de la actori
--      autentificati si DEDUPLICAT per user (audit vuln. #9), dar mat view-ul
--      — singurul folosit efectiv — numara count(*) pe telemetrie anonima.
--      Restaurat: COUNT(DISTINCT actor_user_id) + actor_user_id IS NOT NULL
--      pe save/share/like/add_to_cart/purchase/comment/follow.
--
-- SIGURANTA IN PRODUCTIE (important):
--   Varianta evidenta — DROP urmat de CREATE ... AS SELECT — tine un lock
--   ACCESS EXCLUSIVE pe numele view-ului din momentul DROP-ului pana la COMMIT,
--   adica pe TOATA durata repopularii (scanare completa peste feed_events).
--   In acel interval, fiecare cerere catre /api/explore/feed se blocheaza,
--   pentru ca interogarea de feed face JOIN pe video_rank_14d.
--   De aceea: construim intai view-ul nou sub alt nume (view-ul live ramane
--   neatins si continua sa serveasca), si abia la final facem schimbul prin
--   RENAME, care e instantaneu. Fereastra de blocare scade de la
--   „cat dureaza agregarea" la cateva milisecunde.
-- ============================================================================

BEGIN;

-- Curata o eventuala incercare anterioara esuata.
DROP MATERIALIZED VIEW IF EXISTS video_rank_14d_new;

-- Partea scumpa: se construieste SUB ALT NUME, fara niciun lock pe view-ul
-- din care citeste feed-ul chiar acum.
CREATE MATERIALIZED VIEW video_rank_14d_new AS
SELECT v.id AS video_id,
    v.duration_ms,
    COALESCE((
        SELECT (
            CASE
                WHEN v.duration_ms IS NULL OR v.duration_ms <= 0 THEN 0::numeric
                ELSE LEAST(COALESCE(sum(fe_1.watch_ms)::numeric, 0::numeric) / v.duration_ms::numeric, 50::numeric)
            END * 5::numeric
            + (count(DISTINCT fe_1.actor_user_id) FILTER (WHERE fe_1.event_type = 'save'  AND fe_1.actor_user_id IS NOT NULL) * 3)::numeric
            + (count(DISTINCT fe_1.actor_user_id) FILTER (WHERE fe_1.event_type = 'share' AND fe_1.actor_user_id IS NOT NULL) * 2)::numeric
            + GREATEST(
                  count(DISTINCT fe_1.actor_user_id) FILTER (WHERE fe_1.event_type = 'like'   AND fe_1.actor_user_id IS NOT NULL)
                - count(DISTINCT fe_1.actor_user_id) FILTER (WHERE fe_1.event_type = 'unlike' AND fe_1.actor_user_id IS NOT NULL),
                0
              )::numeric * 1.5
            + (count(*) FILTER (WHERE fe_1.event_type = 'completion') * 5)::numeric
            + (count(DISTINCT fe_1.actor_user_id) FILTER (WHERE fe_1.event_type = 'add_to_cart' AND fe_1.actor_user_id IS NOT NULL) * 4)::numeric
            + (count(DISTINCT fe_1.actor_user_id) FILTER (WHERE fe_1.event_type = 'purchase'    AND fe_1.actor_user_id IS NOT NULL) * 8)::numeric
            + (count(*) FILTER (WHERE fe_1.event_type = 'more_like_this') * 4)::numeric
            + (count(*) FILTER (WHERE fe_1.event_type = 'product_click') * 1)::numeric
            + (count(DISTINCT fe_1.actor_user_id) FILTER (WHERE fe_1.event_type = 'comment' AND fe_1.actor_user_id IS NOT NULL) * 4)::numeric
            + (count(DISTINCT fe_1.actor_user_id) FILTER (WHERE fe_1.event_type = 'follow'  AND fe_1.actor_user_id IS NOT NULL) * 4)::numeric
            - (count(*) FILTER (WHERE fe_1.event_type = 'skip_fast') * 4)::numeric
            - (count(*) FILTER (WHERE fe_1.event_type = 'not_interested') * 6)::numeric
            - (count(*) FILTER (WHERE fe_1.event_type = 'report') * 10)::numeric
        )
        FROM feed_events fe_1
        WHERE fe_1.video_id = v.id AND fe_1.occurred_at > (now() - interval '14 days')
    ), 0::numeric)
    -- RE-WATCH: vieweri distincti (user sau sesiune) cu 2+ 'video_view' SAU cel
    -- putin un eveniment explicit 'rewatch' (bucla 2+ in player).
    -- LEAST(..., 3) = max 3 puncte de re-watch per viewer => anti-spam.
    + COALESCE((
        SELECT sum(LEAST(GREATEST(rw.views - 1, 0) + rw.rewatches, 3)) * 6
        FROM (
            SELECT COALESCE(fe_r.actor_user_id::text, fe_r.session_id) AS viewer,
                   count(*) FILTER (WHERE fe_r.event_type = 'video_view') AS views,
                   count(*) FILTER (WHERE fe_r.event_type = 'rewatch')    AS rewatches
            FROM feed_events fe_r
            WHERE fe_r.video_id = v.id
              AND fe_r.event_type IN ('video_view', 'rewatch')
              AND fe_r.occurred_at > (now() - interval '14 days')
              AND COALESCE(fe_r.actor_user_id::text, fe_r.session_id) IS NOT NULL
            GROUP BY 1
            HAVING count(*) FILTER (WHERE fe_r.event_type = 'video_view') >= 2
                OR count(*) FILTER (WHERE fe_r.event_type = 'rewatch') >= 1
        ) rw
    ), 0::numeric) AS rank_score,
    count(fe.id) AS event_count_14d,
    now() AS computed_at
FROM videos v
LEFT JOIN feed_events fe
    ON fe.video_id = v.id AND fe.occurred_at > (now() - interval '14 days')
WHERE v.status = 'ready' AND v.is_hidden = false AND v.visibility = 'public'
GROUP BY v.id, v.duration_ms;

-- Index unic — obligatoriu pentru REFRESH MATERIALIZED VIEW CONCURRENTLY.
CREATE UNIQUE INDEX video_rank_14d_new_video_uidx ON video_rank_14d_new (video_id);

-- ---------------------------------------------------------------------------
-- Schimbul propriu-zis. De aici incepe lock-ul ACCESS EXCLUSIVE si tine doar
-- cateva milisecunde, pana la COMMIT.
-- ---------------------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS video_rank_14d;
ALTER MATERIALIZED VIEW video_rank_14d_new RENAME TO video_rank_14d;
ALTER INDEX video_rank_14d_new_video_uidx RENAME TO idx_video_rank_14d_video;

INSERT INTO schema_migrations (version)
VALUES ('20260824_0001_video_rank_fix_events')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- Dupa migrare: statisticile sunt goale pe view-ul nou pana la primul ANALYZE.
ANALYZE video_rank_14d;
