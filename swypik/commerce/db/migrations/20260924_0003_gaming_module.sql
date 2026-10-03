-- 20260924_0003_gaming_module.sql
-- Swypik Gaming Hub: Arcade HTML5, Daily Trivia, Leaderboards, SWYP Rewards

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Jocuri Înregistrate
CREATE TABLE IF NOT EXISTS gaming_games (
    id VARCHAR(64) PRIMARY KEY,
    title VARCHAR(128) NOT NULL,
    slug VARCHAR(64) UNIQUE NOT NULL,
    category VARCHAR(32) NOT NULL,
    source_type VARCHAR(32) NOT NULL DEFAULT 'self_hosted',
    embed_url TEXT NOT NULL,
    thumbnail_url TEXT NOT NULL,
    min_play_duration_sec INT DEFAULT 15,
    reward_enabled BOOLEAN DEFAULT true,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Seed jocuri de lansare
INSERT INTO gaming_games (id, title, slug, category, embed_url, thumbnail_url, min_play_duration_sec) VALUES
  ('game_2048', '2048 Classic', '2048', 'puzzle', '/games/2048/index.html', 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=600&auto=format&fit=crop&q=80', 20),
  ('game_flappy', 'Flappy Swyp', 'flappy', 'casual', '/games/flappy/index.html', 'https://images.unsplash.com/photo-1579373903781-fd5c0c30c4cd?w=600&auto=format&fit=crop&q=80', 10),
  ('game_sudoku', 'Daily Sudoku', 'sudoku', 'puzzle', '/games/sudoku/index.html', 'https://images.unsplash.com/photo-1580541832626-2a7131ee809f?w=600&auto=format&fit=crop&q=80', 30)
ON CONFLICT (id) DO NOTHING;

-- 2. Scoruri și clasamente
CREATE TABLE IF NOT EXISTS gaming_scores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    game_id VARCHAR(64) NOT NULL REFERENCES gaming_games(id) ON DELETE CASCADE,
    score BIGINT NOT NULL,
    duration_ms INT NOT NULL,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gaming_scores_game_score ON gaming_scores(game_id, score DESC);
CREATE INDEX IF NOT EXISTS idx_gaming_scores_user ON gaming_scores(user_id, created_at DESC);

-- 3. Profile de Gamification (XP, Nivel, Streak Trivia)
CREATE TABLE IF NOT EXISTS gaming_user_profiles (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    xp_points BIGINT DEFAULT 0 CHECK (xp_points >= 0),
    level INT DEFAULT 1 CHECK (level >= 1),
    trivia_streak_days INT DEFAULT 0,
    last_trivia_at TIMESTAMPTZ,
    badges JSONB DEFAULT '[]'::jsonb,
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- 4. Sesiuni active de Trivia (Open Trivia DB anti-cheat)
CREATE TABLE IF NOT EXISTS gaming_trivia_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    questions JSONB NOT NULL,
    current_index INT DEFAULT 0,
    score INT DEFAULT 0,
    completed BOOLEAN DEFAULT false,
    started_at TIMESTAMPTZ DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);

-- 5. Reguli de Emisie SWYP pentru Gaming (dacă tabelul swyp_emission_rules există)
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'swyp_emission_rules') THEN
    INSERT INTO swyp_emission_rules (action, amount_units, daily_cap_units, requires_paid_tx, enabled)
    VALUES 
      ('gaming_trivia_daily', 200, 200, false, true),
      ('gaming_arcade_score', 50, 300, false, true)
    ON CONFLICT (action) DO UPDATE SET enabled = true;
  END IF;
END $$;

COMMIT;
