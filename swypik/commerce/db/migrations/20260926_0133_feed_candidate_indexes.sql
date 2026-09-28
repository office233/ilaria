-- 20260926_0133_feed_candidate_indexes
--
-- Indexuri pentru sursele de candidați și paginarea keyset (lib/feed/candidates/*,
-- lib/feed/keyset.ts): toate ordonează după COALESCE(published_at, created_at)
-- DESC, id DESC peste clipurile vizibile (ready + public + neascuns + safe).
-- Idempotent. (Pe o tabelă mare: rulați manual cu CREATE INDEX CONCURRENTLY,
-- în afara tranzacției, înainte de deploy.)

BEGIN;

CREATE INDEX IF NOT EXISTS videos_feed_visible_recent_idx
  ON videos ((COALESCE(published_at, created_at)) DESC, id DESC)
  WHERE status = 'ready' AND visibility = 'public' AND is_hidden = false AND effective_label = 'safe';

CREATE INDEX IF NOT EXISTS videos_feed_creator_recent_idx
  ON videos (creator_id, (COALESCE(published_at, created_at)) DESC, id DESC)
  WHERE status = 'ready' AND visibility = 'public' AND is_hidden = false AND effective_label = 'safe';

COMMIT;
