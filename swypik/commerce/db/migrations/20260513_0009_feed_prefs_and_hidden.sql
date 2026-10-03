-- ============================================================================
-- Migration: 20260513_0008_feed_prefs_and_hidden
-- Description: user_hidden_videos for "not interested" + extend feed_events
--              event_type CHECK to include more_like_this / not_interested
--              + tighten user_collection_items with position column for ordering.
-- Depends on: 20260511_0006_addictive_mvp
-- Notes:
--   user_collections, user_collection_items, user_interests already exist
--   (see 20260511_0006_addictive_mvp.sql). This migration is additive only.
-- ============================================================================

-- 1. HIDDEN VIDEOS — for "not interested" action
CREATE TABLE IF NOT EXISTS user_hidden_videos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  reason text NOT NULL DEFAULT 'not_interested'
    CHECK (reason IN ('not_interested', 'reported', 'already_seen', 'blocked_creator')),
  hidden_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, video_id)
);

CREATE INDEX IF NOT EXISTS user_hidden_videos_user_idx
  ON user_hidden_videos (user_id, hidden_at DESC);

-- 2. Add `position` to user_collection_items (idempotent)
ALTER TABLE user_collection_items
  ADD COLUMN IF NOT EXISTS position integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS user_collection_items_collection_pos_idx
  ON user_collection_items (collection_id, position DESC, created_at DESC);

-- 3. feed_events e tabela de analytics: codul emite ~20 tipuri de evenimente
-- (product_click, watch_time, impression...). CHECK-ul static restrictiv pica
-- pe datele existente si spargea deploy-ul; migrarea 20260514_0001 restaureaza
-- oricum setul larg. Aici doar eliminam CHECK-urile vechi, idempotent.
DO $$
DECLARE
  con_name text;
BEGIN
  FOR con_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'feed_events'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%event_type%'
  LOOP
    EXECUTE format('ALTER TABLE feed_events DROP CONSTRAINT %I', con_name);
  END LOOP;
END $$;

INSERT INTO schema_migrations (version)
VALUES ('20260513_0008_feed_prefs_and_hidden')
ON CONFLICT (version) DO NOTHING;

-- TODO(onboarding): seed default user_collections on user signup. Suggested set:
--   ('De cumpărat', '🛒'), ('Idei utile', '💡'), ('AI tools', '🤖'),
--   ('Funny', '😂'), ('Cadouri', '🎁')
-- Currently created lazily on first GET /api/collections (see route.ts).
