-- 2026-08-11 (audit "vreau ce au restul"): semnal RE-WATCH în ranking.
-- TikTok/Meta folosesc re-watch ca semnal puternic de interes. La noi:
-- un viewer distinct care generează 2+ evenimente 'view' pe același clip în
-- 14 zile = re-watch (dedup per viewer, nu inflatabil prin refresh spam:
-- capped la 3 per viewer). Pondera: +6 per re-watch distinct.
--
-- Recreăm mat view-ul video_rank_14d cu termenul nou. REFRESH-ul rulează
-- din cron (acum la 1 min). Index unic necesar pentru REFRESH CONCURRENTLY.

BEGIN;

DROP MATERIALIZED VIEW IF EXISTS video_rank_14d;

CREATE MATERIALIZED VIEW video_rank_14d AS
SELECT v.id AS video_id,
    v.duration_ms,
    COALESCE((
        SELECT (
            CASE
                WHEN v.duration_ms IS NULL OR v.duration_ms <= 0 THEN 0::numeric
                ELSE LEAST(COALESCE(sum(fe_1.watch_ms)::numeric, 0::numeric) / v.duration_ms::numeric, 50::numeric)
            END * 5::numeric
            + (count(*) FILTER (WHERE fe_1.event_type = 'save') * 3)::numeric
            + (count(*) FILTER (WHERE fe_1.event_type = 'share') * 2)::numeric
            + (count(*) FILTER (WHERE fe_1.event_type = 'like'))::numeric * 1.5
            + (count(*) FILTER (WHERE fe_1.event_type = 'completion') * 5)::numeric
            + (count(*) FILTER (WHERE fe_1.event_type = 'add_to_cart') * 4)::numeric
            + (count(*) FILTER (WHERE fe_1.event_type = 'purchase') * 8)::numeric
            + (count(*) FILTER (WHERE fe_1.event_type = 'more_like_this') * 4)::numeric
            + (count(*) FILTER (WHERE fe_1.event_type = 'product_click') * 1)::numeric
            + (count(*) FILTER (WHERE fe_1.event_type = 'comment') * 4)::numeric
            + (count(*) FILTER (WHERE fe_1.event_type = 'follow') * 4)::numeric
            - (count(*) FILTER (WHERE fe_1.event_type = 'skip_fast') * 4)::numeric
            - (count(*) FILTER (WHERE fe_1.event_type = 'not_interested') * 6)::numeric
            - (count(*) FILTER (WHERE fe_1.event_type = 'report') * 10)::numeric
        )
        FROM feed_events fe_1
        WHERE fe_1.video_id = v.id AND fe_1.occurred_at > (now() - interval '14 days')
    ), 0::numeric)
    -- RE-WATCH: vieweri distincți (user sau sesiune) cu 2+ view-uri pe clip.
    -- LEAST(n-1, 3) = max 3 puncte de re-watch per viewer → anti-spam.
    + COALESCE((
        SELECT sum(LEAST(rw.views - 1, 3)) * 6
        FROM (
            SELECT COALESCE(fe_r.actor_user_id::text, fe_r.session_id) AS viewer,
                   count(*) AS views
            FROM feed_events fe_r
            WHERE fe_r.video_id = v.id
              AND fe_r.event_type = 'view'
              AND fe_r.occurred_at > (now() - interval '14 days')
              AND COALESCE(fe_r.actor_user_id::text, fe_r.session_id) IS NOT NULL
            GROUP BY 1
            HAVING count(*) >= 2
        ) rw
    ), 0::numeric) AS rank_score,
    count(fe.id) AS event_count_14d,
    now() AS computed_at
FROM videos v
LEFT JOIN feed_events fe
    ON fe.video_id = v.id AND fe.occurred_at > (now() - interval '14 days')
WHERE v.status = 'ready' AND v.is_hidden = false AND v.visibility = 'public'
GROUP BY v.id, v.duration_ms;

CREATE UNIQUE INDEX idx_video_rank_14d_video ON video_rank_14d (video_id);

COMMIT;
