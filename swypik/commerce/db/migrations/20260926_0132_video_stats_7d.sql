-- 20260926_0132_video_stats_7d
--
-- Statistici pe 7 zile per clip pentru ranker-ul nou (lib/feed/features.ts,
-- lib/feed/candidates/trending.ts, explore.ts). Toate contoarele sunt pe
-- ACTORI DISTINCȚI (user sau sesiune) — un spammer contează o singură dată,
-- deci nu poate umfla o rată (audit feed-algorithm, secțiunea securitate).
-- watch_ms = suma evenimentelor watch_time (plafonate deja la ingest,
-- lib/feed/event-guards.ts). Refresh: /api/cron/refresh-rank (CONCURRENTLY).
-- video_rank_14d rămâne pentru /api/feed/universal. Idempotent.

BEGIN;

CREATE MATERIALIZED VIEW IF NOT EXISTS video_stats_7d AS
WITH ev AS (
  SELECT fe.video_id,
         fe.event_type,
         COALESCE(fe.actor_user_id::text, fe.session_id) AS actor,
         fe.actor_user_id,
         fe.watch_ms
    FROM feed_events fe
   WHERE fe.video_id IS NOT NULL
     AND fe.occurred_at > now() - interval '7 days'
     AND COALESCE(fe.actor_user_id::text, fe.session_id) IS NOT NULL
)
SELECT ev.video_id,
       COUNT(DISTINCT ev.actor) FILTER (WHERE ev.event_type IN ('impression', 'video_view'))::int AS impressions,
       COUNT(DISTINCT ev.actor) FILTER (WHERE ev.event_type = 'watch_time')::int                 AS viewers,
       COUNT(DISTINCT ev.actor) FILTER (WHERE ev.event_type = 'completion')::int                 AS completions,
       GREATEST(
         COUNT(DISTINCT ev.actor) FILTER (WHERE ev.event_type = 'like')
         - COUNT(DISTINCT ev.actor) FILTER (WHERE ev.event_type = 'unlike'), 0)::int             AS likes,
       COUNT(DISTINCT ev.actor) FILTER (WHERE ev.event_type = 'comment')::int                    AS comments,
       COUNT(DISTINCT ev.actor) FILTER (WHERE ev.event_type = 'share')::int                      AS shares,
       GREATEST(
         COUNT(DISTINCT ev.actor) FILTER (WHERE ev.event_type = 'save')
         - COUNT(DISTINCT ev.actor) FILTER (WHERE ev.event_type = 'unsave'), 0)::int             AS saves,
       COUNT(DISTINCT ev.actor) FILTER (WHERE ev.event_type = 'follow')::int                     AS follows,
       COUNT(DISTINCT ev.actor) FILTER (WHERE ev.event_type = 'skip_fast')::int                  AS skips,
       COUNT(DISTINCT ev.actor) FILTER (
         WHERE ev.event_type = 'not_interested'
            OR (ev.event_type = 'report' AND ev.actor_user_id IS NOT NULL))::int                 AS negatives,
       COALESCE(SUM(ev.watch_ms) FILTER (WHERE ev.event_type = 'watch_time'), 0)::bigint        AS watch_ms,
       now() AS computed_at
  FROM ev
 GROUP BY ev.video_id;

CREATE UNIQUE INDEX IF NOT EXISTS video_stats_7d_video_uidx ON video_stats_7d (video_id);

COMMIT;

ANALYZE video_stats_7d;
