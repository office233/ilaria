CREATE DATABASE IF NOT EXISTS social_analytics;

CREATE TABLE IF NOT EXISTS social_analytics.raw_events
(
  event_id UUID,
  stream_name LowCardinality(String),
  event_type LowCardinality(String),
  aggregate_type LowCardinality(String),
  aggregate_id Nullable(UUID),
  actor_user_id Nullable(UUID),
  occurred_at DateTime64(3, 'UTC'),
  ingested_at DateTime64(3, 'UTC') DEFAULT now64(3),
  payload String,
  headers String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (stream_name, event_type, occurred_at, event_id);

CREATE TABLE IF NOT EXISTS social_analytics.video_events
(
  event_id UUID,
  event_name LowCardinality(String),
  video_id UUID,
  creator_id Nullable(UUID),
  user_id Nullable(UUID),
  session_id String,
  source LowCardinality(String),
  watch_ms UInt32,
  duration_ms UInt32,
  position_ms UInt32,
  occurred_at DateTime64(3, 'UTC'),
  ingested_at DateTime64(3, 'UTC') DEFAULT now64(3),
  properties String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (video_id, event_name, occurred_at, event_id);

CREATE TABLE IF NOT EXISTS social_analytics.feed_impressions
(
  event_id UUID,
  feed_item_id Nullable(UUID),
  user_id Nullable(UUID),
  video_id UUID,
  creator_id Nullable(UUID),
  feed_type LowCardinality(String),
  event_name LowCardinality(String),
  position UInt16,
  score Float64,
  reason LowCardinality(String),
  occurred_at DateTime64(3, 'UTC'),
  ingested_at DateTime64(3, 'UTC') DEFAULT now64(3),
  properties String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (feed_type, occurred_at, user_id, video_id, event_id);

CREATE TABLE IF NOT EXISTS social_analytics.commerce_events
(
  event_id UUID,
  event_name LowCardinality(String),
  order_id Nullable(UUID),
  order_item_id Nullable(UUID),
  product_id Nullable(UUID),
  creator_id Nullable(UUID),
  buyer_user_id Nullable(UUID),
  video_id Nullable(UUID),
  currency FixedString(3),
  gross_amount_cents UInt64,
  commission_amount_cents UInt64,
  occurred_at DateTime64(3, 'UTC'),
  ingested_at DateTime64(3, 'UTC') DEFAULT now64(3),
  properties String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (event_name, occurred_at, creator_id, product_id, event_id);

CREATE TABLE IF NOT EXISTS social_analytics.moderation_events
(
  event_id UUID,
  event_name LowCardinality(String),
  case_id Nullable(UUID),
  report_id Nullable(UUID),
  actor_user_id Nullable(UUID),
  target_user_id Nullable(UUID),
  target_video_id Nullable(UUID),
  target_comment_id Nullable(UUID),
  severity LowCardinality(String),
  action_type LowCardinality(String),
  occurred_at DateTime64(3, 'UTC'),
  ingested_at DateTime64(3, 'UTC') DEFAULT now64(3),
  properties String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (event_name, occurred_at, severity, event_id);
