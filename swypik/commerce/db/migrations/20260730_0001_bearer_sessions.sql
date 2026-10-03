-- 20260730_0001_bearer_sessions.sql
-- Bearer tokens for PWA/mobile clients reuse the existing `user_sessions`
-- table (opaque token, sha256 hash) — no JWT needed.
--   kind = 'cookie'  → classic httpOnly swypik_session cookie
--   kind = 'bearer'  → Authorization: Bearer <token> (PWA / mobile)

BEGIN;

ALTER TABLE user_sessions
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'cookie'
    CHECK (kind IN ('cookie', 'bearer'));

-- user_agent may already exist on some environments; guard anyway.
ALTER TABLE user_sessions
  ADD COLUMN IF NOT EXISTS user_agent text;

CREATE INDEX IF NOT EXISTS user_sessions_kind_idx
  ON user_sessions (kind, expires_at DESC)
  WHERE revoked_at IS NULL;

COMMIT;
