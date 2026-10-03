-- 20260924_0006_gaming_fixes.sql
-- Gaming hub hardening: server-authoritative trivia + scoring, kill broken
-- sudoku seed, daily XP cap. Idempotent — safe to re-run; does not touch
-- 20260924_0003_gaming_module.sql (may already be applied in prod).

BEGIN;

-- 1. game_sudoku pointed at /games/sudoku/index.html which was never built.
--    Deactivate rather than delete so historical gaming_scores rows keep
--    their FK target.
UPDATE gaming_games SET is_active = false WHERE id = 'game_sudoku';

-- 2. Signed, single-use "game start" tokens. A score submission must present
--    one of these; duration is measured server-side (started_at -> now()).
CREATE TABLE IF NOT EXISTS gaming_game_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    game_id VARCHAR(64) NOT NULL REFERENCES gaming_games(id) ON DELETE CASCADE,
    token_hash CHAR(64) NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    UNIQUE (token_hash)
);

CREATE INDEX IF NOT EXISTS idx_gaming_game_sessions_user ON gaming_game_sessions(user_id, started_at DESC);

-- 3. Server-authoritative trivia rounds: questions + correct answers live
--    server-side; the client only ever sees a round token + question text.
CREATE TABLE IF NOT EXISTS gaming_trivia_rounds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash CHAR(64) NOT NULL,
    questions JSONB NOT NULL, -- [{id, category, difficulty, question, options, correctAnswer}]
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    score INT,
    UNIQUE (token_hash)
);

CREATE INDEX IF NOT EXISTS idx_gaming_trivia_rounds_user ON gaming_trivia_rounds(user_id, created_at DESC);

-- 4. Daily XP cap — tracked per user/day, independent of the SWYP ledger
--    (swyp_emission_rules already caps SWYP itself via lib/swyp/rewards.ts).
CREATE TABLE IF NOT EXISTS gaming_xp_daily (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day DATE NOT NULL,
    xp_earned INT NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
);

COMMIT;
