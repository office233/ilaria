-- ============================================================================
-- Migration: 20260514_0001_feed_events_check_restore
-- Description: CRITICAL FIX. Migrația 20260513_0008_feed_prefs_and_hidden a
--              suprascris CHECK-ul lui feed_events.event_type cu un set
--              restrâns (doar 11 valori legacy + 2 noi), eliminând cele 23
--              event types granulare introduse de 20260513_0008_feed_events_tracking.
--              Rezultat: tot tracking-ul TikTok-style (video_view, watch_time,
--              completion, skip_fast, like, save, share, comment, follow,
--              product_click, add_to_cart, purchase, etc.) este respins
--              silențios la INSERT, iar ranking-ul personalizat funcționează
--              degeaba.
--
--              Această migrație reaplică CHECK-ul larg din feed_events_tracking
--              + păstrează valorile suplimentare introduse de feed_prefs_and_hidden
--              (`video_hidden`, `creator_unfollowed`).
-- ============================================================================

BEGIN;

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
    'video_shared', 'comment_created', 'creator_followed',
    -- additional events introduced by feed_prefs_and_hidden
    'video_hidden', 'creator_unfollowed'
  ));

INSERT INTO schema_migrations (version)
VALUES ('20260514_0001_feed_events_check_restore')
ON CONFLICT (version) DO NOTHING;

COMMIT;
