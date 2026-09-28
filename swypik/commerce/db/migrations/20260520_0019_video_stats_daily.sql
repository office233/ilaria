-- Migration: 20260520_0019_video_stats_daily.sql
-- Daily aggregated video stats, populated by /api/cron/aggregate-video-stats
-- from feed_events. Enables fast creator analytics queries over arbitrary
-- ranges and exposes impressions, views, watch_time, completions, ctr.

BEGIN;

CREATE TABLE IF NOT EXISTS video_stats_daily (
  video_id        UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  stat_date       DATE NOT NULL,
  impressions     BIGINT NOT NULL DEFAULT 0,
  views           BIGINT NOT NULL DEFAULT 0,
  watch_ms_sum    BIGINT NOT NULL DEFAULT 0,
  completions     BIGINT NOT NULL DEFAULT 0,
  likes           BIGINT NOT NULL DEFAULT 0,
  saves           BIGINT NOT NULL DEFAULT 0,
  shares          BIGINT NOT NULL DEFAULT 0,
  comments        BIGINT NOT NULL DEFAULT 0,
  product_clicks  BIGINT NOT NULL DEFAULT 0,
  add_to_cart     BIGINT NOT NULL DEFAULT 0,
  purchases       BIGINT NOT NULL DEFAULT 0,
  follows         BIGINT NOT NULL DEFAULT 0,
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (video_id, stat_date)
);

CREATE INDEX IF NOT EXISTS idx_video_stats_daily_date
  ON video_stats_daily (stat_date DESC);

COMMIT;
