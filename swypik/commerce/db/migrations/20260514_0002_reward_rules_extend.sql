-- ============================================================================
-- Migration: 20260514_0002_reward_rules_extend
-- Description: Adaugă reward_rules pentru acțiuni MVP care lipseau:
--              `like`, `comment`, `video_view`. Restul (`video_saved`,
--              `video_shared`, `product_click`, `add_to_cart`, `purchase`,
--              `daily_login`, `first_upload`, `video_approved`) există deja
--              din migrația 20260511_0006_addictive_mvp.sql.
--
--              Cooldown-urile sunt agresive pentru a evita farming
--              (ex: `like` cooldown 1 min per user, daily limit 100).
--              `video_view` are cooldown 0 dar daily_limit 200, deci un user
--              primește puncte pentru max 200 view-uri/zi.
-- ============================================================================

BEGIN;

INSERT INTO reward_rules (action, points, cooldown_minutes, daily_limit, lock_days, description, is_active)
VALUES
  ('like',       1, 1,    100, 0, 'Liked a video',                   true),
  ('comment',    3, 0,    50,  0, 'Commented on a video',            true),
  ('video_view', 1, 0,    200, 0, 'Watched a video to completion',   true)
ON CONFLICT (action) DO UPDATE
  SET points           = EXCLUDED.points,
      cooldown_minutes = EXCLUDED.cooldown_minutes,
      daily_limit      = EXCLUDED.daily_limit,
      description      = EXCLUDED.description,
      is_active        = EXCLUDED.is_active;

INSERT INTO schema_migrations (version)
VALUES ('20260514_0002_reward_rules_extend')
ON CONFLICT (version) DO NOTHING;

COMMIT;
