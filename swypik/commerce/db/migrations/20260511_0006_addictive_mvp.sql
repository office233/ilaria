-- ============================================================================
-- Migration: 20260511_0006_addictive_mvp
-- Description: User engagement, SWYP Points, Challenges, Watch Events
-- Depends on: 20260510_0001_social_marketplace (users, videos, etc.)
-- ============================================================================

-- 1. USER INTERESTS — onboarding + feed personalization
CREATE TABLE IF NOT EXISTS user_interests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic text NOT NULL,
  weight numeric(5,3) NOT NULL DEFAULT 1.000 CHECK (weight BETWEEN -5.000 AND 5.000),
  source text NOT NULL DEFAULT 'onboarding' CHECK (source IN ('onboarding', 'explicit', 'inferred', 'more_like_this', 'not_interested')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, topic)
);

CREATE INDEX IF NOT EXISTS user_interests_user_weight_idx
  ON user_interests (user_id, weight DESC);

-- 2. USER WATCH EVENTS — granular engagement tracking
CREATE TABLE IF NOT EXISTS user_watch_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  session_id text,
  video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN (
    'impression', 'view_start', 'view_end',
    'skip_fast', 'watch_complete', 'rewatch',
    'pause', 'resume', 'seek',
    'like', 'unlike', 'save', 'unsave',
    'share', 'comment',
    'follow', 'unfollow',
    'product_click', 'add_to_cart', 'purchase',
    'more_like_this', 'not_interested', 'report'
  )),
  watch_duration_ms integer CHECK (watch_duration_ms IS NULL OR watch_duration_ms >= 0),
  video_duration_ms integer CHECK (video_duration_ms IS NULL OR video_duration_ms > 0),
  completion_pct numeric(5,2) CHECK (completion_pct IS NULL OR completion_pct BETWEEN 0 AND 200),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  client_ip inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Partitioned-ready indexes for high volume
CREATE INDEX IF NOT EXISTS user_watch_events_user_recent_idx
  ON user_watch_events (user_id, created_at DESC)
  WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS user_watch_events_video_type_idx
  ON user_watch_events (video_id, event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS user_watch_events_type_recent_idx
  ON user_watch_events (event_type, created_at DESC);

-- 3. USER COLLECTIONS — user-facing saved collections (different from creator_collections)
CREATE TABLE IF NOT EXISTS user_collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  slug text,
  icon text,
  color text,
  is_default boolean NOT NULL DEFAULT false,
  item_count integer NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS user_collections_user_slug_uidx
  ON user_collections (user_id, slug)
  WHERE slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS user_collections_user_sort_idx
  ON user_collections (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS user_collection_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id uuid NOT NULL REFERENCES user_collections(id) ON DELETE CASCADE,
  video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (collection_id, video_id)
);

CREATE INDEX IF NOT EXISTS user_collection_items_video_idx
  ON user_collection_items (video_id);

-- 4. SWYP WALLETS — internal points ledger
CREATE TABLE IF NOT EXISTS swyp_wallets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  balance_points bigint NOT NULL DEFAULT 0 CHECK (balance_points >= 0),
  locked_points bigint NOT NULL DEFAULT 0 CHECK (locked_points >= 0),
  lifetime_earned bigint NOT NULL DEFAULT 0 CHECK (lifetime_earned >= 0),
  lifetime_spent bigint NOT NULL DEFAULT 0 CHECK (lifetime_spent >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id uuid NOT NULL REFERENCES swyp_wallets(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('earn', 'spend', 'lock', 'unlock', 'expire', 'admin_grant', 'admin_deduct')),
  amount_points bigint NOT NULL CHECK (amount_points > 0),
  balance_after bigint NOT NULL,
  reason text NOT NULL,
  source_type text,
  source_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wallet_transactions_wallet_recent_idx
  ON wallet_transactions (wallet_id, created_at DESC);
CREATE INDEX IF NOT EXISTS wallet_transactions_source_idx
  ON wallet_transactions (source_type, source_id)
  WHERE source_id IS NOT NULL;

-- 5. REWARD RULES — configurable point awards
CREATE TABLE IF NOT EXISTS reward_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action text NOT NULL UNIQUE,
  points integer NOT NULL CHECK (points > 0),
  cooldown_minutes integer NOT NULL DEFAULT 0,
  daily_limit integer,
  description text,
  is_active boolean NOT NULL DEFAULT true,
  lock_days integer NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Seed default reward rules
INSERT INTO reward_rules (action, points, cooldown_minutes, daily_limit, description, lock_days) VALUES
  ('video_approved',    100, 0,    10,  'Video aprobat și publicat', 7),
  ('video_view_1k',     50,  0,    NULL,'Clip atinge 1000 views', 7),
  ('video_saved',       5,   0,    50,  'Cineva ți-a salvat clipul', 0),
  ('video_shared',      10,  0,    30,  'Cineva ți-a distribuit clipul', 0),
  ('product_click',     2,   1,    100, 'Click pe produs din clipul tău', 0),
  ('add_to_cart',       5,   0,    50,  'Produs adăugat în coș din clipul tău', 0),
  ('purchase',          50,  0,    NULL,'Vânzare generată prin clipul tău', 7),
  ('daily_login',       5,   1440, 1,   'Login zilnic', 0),
  ('daily_streak_7',    50,  0,    NULL,'Streak de 7 zile consecutive', 0),
  ('daily_streak_30',   200, 0,    NULL,'Streak de 30 zile consecutive', 0),
  ('challenge_entry',   10,  0,    5,   'Participare la challenge', 0),
  ('challenge_win',     200, 0,    1,   'Câștigător challenge', 7),
  ('first_upload',      200, 0,    1,   'Primul clip încărcat', 0),
  ('first_sale',        500, 0,    1,   'Prima vânzare generată', 7)
ON CONFLICT (action) DO NOTHING;

-- 6. REWARD EVENTS — log of all point awards
CREATE TABLE IF NOT EXISTS reward_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rule_id uuid REFERENCES reward_rules(id) ON DELETE SET NULL,
  action text NOT NULL,
  points_awarded integer NOT NULL,
  transaction_id uuid REFERENCES wallet_transactions(id) ON DELETE SET NULL,
  source_type text,
  source_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reward_events_user_recent_idx
  ON reward_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS reward_events_action_idx
  ON reward_events (action, created_at DESC);

-- 7. DAILY CHALLENGES
CREATE TABLE IF NOT EXISTS daily_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  description text,
  challenge_type text NOT NULL DEFAULT 'video' CHECK (challenge_type IN ('video', 'review', 'engagement', 'commerce', 'community')),
  topic text,
  reward_points integer NOT NULL DEFAULT 50,
  max_entries integer,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'completed', 'cancelled')),
  featured boolean NOT NULL DEFAULT false,
  banner_url text,
  rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS daily_challenges_active_idx
  ON daily_challenges (status, starts_at DESC)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS challenge_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_id uuid NOT NULL REFERENCES daily_challenges(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id uuid REFERENCES videos(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'approved', 'winner', 'disqualified')),
  score numeric(10,4) NOT NULL DEFAULT 0,
  rank integer,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (challenge_id, user_id)
);

CREATE INDEX IF NOT EXISTS challenge_entries_challenge_score_idx
  ON challenge_entries (challenge_id, score DESC);
CREATE INDEX IF NOT EXISTS challenge_entries_user_idx
  ON challenge_entries (user_id, created_at DESC);

-- 8. USER STREAKS
CREATE TABLE IF NOT EXISTS user_streaks (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  current_streak integer NOT NULL DEFAULT 0 CHECK (current_streak >= 0),
  longest_streak integer NOT NULL DEFAULT 0 CHECK (longest_streak >= 0),
  last_active_date date NOT NULL DEFAULT CURRENT_DATE,
  total_active_days integer NOT NULL DEFAULT 0 CHECK (total_active_days >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Triggers
DO $$
BEGIN
  IF to_regprocedure('social_set_updated_at()') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_user_interests_set_updated_at') THEN
      CREATE TRIGGER trg_user_interests_set_updated_at BEFORE UPDATE ON user_interests FOR EACH ROW EXECUTE FUNCTION social_set_updated_at();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_user_collections_set_updated_at') THEN
      CREATE TRIGGER trg_user_collections_set_updated_at BEFORE UPDATE ON user_collections FOR EACH ROW EXECUTE FUNCTION social_set_updated_at();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_swyp_wallets_set_updated_at') THEN
      CREATE TRIGGER trg_swyp_wallets_set_updated_at BEFORE UPDATE ON swyp_wallets FOR EACH ROW EXECUTE FUNCTION social_set_updated_at();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_daily_challenges_set_updated_at') THEN
      CREATE TRIGGER trg_daily_challenges_set_updated_at BEFORE UPDATE ON daily_challenges FOR EACH ROW EXECUTE FUNCTION social_set_updated_at();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_challenge_entries_set_updated_at') THEN
      CREATE TRIGGER trg_challenge_entries_set_updated_at BEFORE UPDATE ON challenge_entries FOR EACH ROW EXECUTE FUNCTION social_set_updated_at();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_user_streaks_set_updated_at') THEN
      CREATE TRIGGER trg_user_streaks_set_updated_at BEFORE UPDATE ON user_streaks FOR EACH ROW EXECUTE FUNCTION social_set_updated_at();
    END IF;
  END IF;
END $$;

INSERT INTO schema_migrations (version)
VALUES ('20260511_0006_addictive_mvp')
ON CONFLICT (version) DO NOTHING;
