-- 20260519_0001_video_rank_mv.sql
-- Pre-aggregates feed_events 14d ranking per video to drop /api/explore/feed latency.
-- Refreshed via /api/cron/refresh-rank (external scheduler, e.g. every 5 min).

BEGIN;

DROP MATERIALIZED VIEW IF EXISTS video_rank_14d;

CREATE MATERIALIZED VIEW video_rank_14d AS
SELECT
  v.id AS video_id,
  v.duration_ms,
  COALESCE((
    SELECT (
        CASE
          WHEN v.duration_ms IS NULL OR v.duration_ms <= 0 THEN 0
          ELSE LEAST(COALESCE(SUM(fe.watch_ms)::numeric, 0) / v.duration_ms, 50)
        END * 5
      + COUNT(*) FILTER (WHERE fe.event_type = 'save')           * 3
      + COUNT(*) FILTER (WHERE fe.event_type = 'share')          * 2
      + COUNT(*) FILTER (WHERE fe.event_type = 'like')           * 1.5
      + COUNT(*) FILTER (WHERE fe.event_type = 'completion')     * 5
      + COUNT(*) FILTER (WHERE fe.event_type = 'add_to_cart')    * 4
      + COUNT(*) FILTER (WHERE fe.event_type = 'purchase')       * 8
      + COUNT(*) FILTER (WHERE fe.event_type = 'more_like_this') * 4
      + COUNT(*) FILTER (WHERE fe.event_type = 'product_click')  * 1
      + COUNT(*) FILTER (WHERE fe.event_type = 'comment')        * 4
      + COUNT(*) FILTER (WHERE fe.event_type = 'follow')         * 4
      - COUNT(*) FILTER (WHERE fe.event_type = 'skip_fast')      * 4
      - COUNT(*) FILTER (WHERE fe.event_type = 'not_interested') * 6
      - COUNT(*) FILTER (WHERE fe.event_type = 'report')         * 10
    )
    FROM feed_events fe
    WHERE fe.video_id = v.id
      AND fe.occurred_at > NOW() - INTERVAL '14 days'
  ), 0)::numeric AS rank_score,
  COUNT(fe.id) AS event_count_14d,
  NOW() AS computed_at
FROM videos v
LEFT JOIN feed_events fe
  ON fe.video_id = v.id AND fe.occurred_at > NOW() - INTERVAL '14 days'
WHERE v.status = 'ready'
  AND v.is_hidden = false
  AND v.visibility = 'public'
GROUP BY v.id, v.duration_ms;

CREATE UNIQUE INDEX video_rank_14d_pk ON video_rank_14d(video_id);
CREATE INDEX video_rank_14d_score_idx ON video_rank_14d(rank_score DESC);

COMMENT ON MATERIALIZED VIEW video_rank_14d IS
  'Pre-aggregated 14d engagement rank per video. Refresh CONCURRENTLY via /api/cron/refresh-rank.';

COMMIT;
