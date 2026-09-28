-- M1.2: Anon voting + attribution ledger
-- Allows pre-signup engagement: vote/save without account, attributed to user at signup.

CREATE TABLE IF NOT EXISTS anon_sessions (
  anon_id          UUID PRIMARY KEY,
  ip_hash          TEXT,
  ua_hash          TEXT,
  fp_hash          TEXT,
  first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  became_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  attributed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_anon_sessions_user
  ON anon_sessions(became_user_id) WHERE became_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_anon_sessions_last_seen
  ON anon_sessions(last_seen_at DESC);

-- Separate table for anon votes (community_post_votes FK requires real user_id).
CREATE TABLE IF NOT EXISTS anon_post_votes (
  post_id          UUID NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  anon_id          UUID NOT NULL REFERENCES anon_sessions(anon_id) ON DELETE CASCADE,
  option_key       TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  attributed_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  attributed_at    TIMESTAMPTZ,
  PRIMARY KEY (post_id, anon_id)
);

CREATE INDEX IF NOT EXISTS idx_anon_post_votes_post_option
  ON anon_post_votes(post_id, option_key);
CREATE INDEX IF NOT EXISTS idx_anon_post_votes_anon
  ON anon_post_votes(anon_id) WHERE attributed_user_id IS NULL;

-- Generic anon action ledger (saves, comments, etc — extensible)
CREATE TABLE IF NOT EXISTS anon_actions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  anon_id          UUID NOT NULL REFERENCES anon_sessions(anon_id) ON DELETE CASCADE,
  kind             TEXT NOT NULL,             -- 'vote' | 'save' | 'share' | 'view'
  target_kind      TEXT NOT NULL,             -- 'post' | 'video' | 'product'
  target_id        UUID NOT NULL,
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  attributed_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  attributed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_anon_actions_anon ON anon_actions(anon_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_anon_actions_target ON anon_actions(target_kind, target_id);
CREATE INDEX IF NOT EXISTS idx_anon_actions_pending_attrib
  ON anon_actions(anon_id) WHERE attributed_user_id IS NULL;
