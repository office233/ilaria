-- Persistent video-view dedupe. Redis/IP remains an abuse throttle, but the
-- source of truth for a counted view is a pseudonymous user/anon identity.

BEGIN;

CREATE TABLE IF NOT EXISTS video_view_dedup (
  video_id          uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  viewer_key        char(64) NOT NULL,
  viewer_kind       text NOT NULL CHECK (viewer_kind IN ('user', 'anon')),
  first_counted_at  timestamptz NOT NULL DEFAULT now(),
  last_counted_at   timestamptz NOT NULL DEFAULT now(),
  count_events      integer NOT NULL DEFAULT 1 CHECK (count_events > 0),
  PRIMARY KEY (video_id, viewer_key)
);

CREATE INDEX IF NOT EXISTS idx_video_view_dedup_last_counted
  ON video_view_dedup (last_counted_at DESC);

COMMIT;
