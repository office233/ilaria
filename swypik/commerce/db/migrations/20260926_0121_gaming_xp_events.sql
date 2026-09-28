-- Gaming ca strat ușor de XP: un registru unic pentru orice XP acordat.
-- UNIQUE (user_id, action, ref) face acordarea idempotentă: aceeași acțiune
-- (ex. trivia din ziua X, prima comandă plătită, runda de joc cu sesiunea Y)
-- nu poate da XP de două ori, oricâte cereri concurente ar veni.
-- Nivelul se calculează dintr-un singur loc: lib/gaming/level.ts.
-- Idempotent.

CREATE TABLE IF NOT EXISTS gaming_xp_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    action VARCHAR(40) NOT NULL,
    ref VARCHAR(120) NOT NULL,
    xp INT NOT NULL DEFAULT 0 CHECK (xp >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_gaming_xp_events_action UNIQUE (user_id, action, ref)
);

CREATE INDEX IF NOT EXISTS idx_gaming_xp_events_user_created
    ON gaming_xp_events (user_id, created_at DESC);
