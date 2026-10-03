-- Migration: extend `feed_events` to support dense interaction tracking for
-- personalised TikTok-style ranking.
--
-- Existing schema (20260510_0001_social_marketplace.sql) modelled `feed_events`
-- as a coarse social fan-out signal (only 7 event types, no session/anon
-- tracking, no watch_ms). This migration relaxes the CHECK constraint, adds
-- the columns we need for ranking and adds the supporting indexes.
--
-- Backwards compatible: existing rows keep their event_type values
-- (`video_published`, `video_liked`, ...) and the legacy writers continue to
-- work. The new tracking pipeline writes the granular events listed below.

BEGIN;

-- 1) New columns -------------------------------------------------------------
ALTER TABLE feed_events
  ADD COLUMN IF NOT EXISTS session_id   text,
  ADD COLUMN IF NOT EXISTS watch_ms     integer,
  ADD COLUMN IF NOT EXISTS position_ms  integer,
  ADD COLUMN IF NOT EXISTS ip_hash      text,
  ADD COLUMN IF NOT EXISTS country      text;

-- Friendly column alias: most app code refers to `created_at`, the original
-- column is `occurred_at`. We keep `occurred_at` and expose a generated alias
-- via a view if downstream code needs both names. Skipped here to avoid double
-- writes; queries should use `occurred_at`.

-- 2) Relax event_type CHECK to cover the full granular set -------------------
DO $$
DECLARE
  con_name text;
BEGIN
  SELECT conname INTO con_name
  FROM pg_constraint
  WHERE conrelid = 'feed_events'::regclass
    AND contype  = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%event_type%';

  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE feed_events DROP CONSTRAINT %I', con_name);
  END IF;
END $$;

ALTER TABLE feed_events
  ADD CONSTRAINT feed_events_event_type_check CHECK (event_type IN (
    -- granular tracking events (TikTok-style ranking inputs)
    'video_view', 'watch_time', 'completion', 'rewatch', 'skip_fast',
    'pause', 'resume', 'seek',
    'like', 'unlike', 'save', 'unsave', 'share', 'comment',
    'follow', 'unfollow',
    'product_click', 'add_to_cart', 'purchase',
    'not_interested', 'more_like_this', 'report',
    'impression',
    -- legacy fan-out events (kept for backwards compatibility)
    'video_published', 'video_viewed', 'video_liked', 'video_saved',
    'video_shared', 'comment_created', 'creator_followed'
  ));

-- 3) Supporting indexes for ranking queries ----------------------------------
CREATE INDEX IF NOT EXISTS feed_events_user_recent_idx
  ON feed_events (actor_user_id, occurred_at DESC)
  WHERE actor_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS feed_events_video_type_idx
  ON feed_events (video_id, event_type)
  WHERE video_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS feed_events_session_recent_idx
  ON feed_events (session_id, occurred_at DESC)
  WHERE session_id IS NOT NULL;

-- BRIN for cheap time-range scans on hot ranking aggregations
CREATE INDEX IF NOT EXISTS feed_events_occurred_at_brin
  ON feed_events USING brin (occurred_at);

-- 4) Sanity: extend metadata default ----------------------------------------
ALTER TABLE feed_events
  ALTER COLUMN metadata SET DEFAULT '{}'::jsonb;

COMMIT;

-- TODO(partitioning): once row volume exceeds ~50M, convert `feed_events` to a
-- RANGE-partitioned table on `occurred_at` (monthly). This requires a full
-- table rebuild and is intentionally left out of this migration. See
-- docs/feed-tracking.md for the planned procedure.
