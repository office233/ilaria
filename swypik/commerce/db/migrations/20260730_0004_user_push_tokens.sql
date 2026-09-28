-- 20260730_0004_user_push_tokens.sql
-- Tabelă canonică pentru token-uri Web Push (înlocuiește push_subscriptions).
-- revoked_at != NULL → token mort (endpoint 404/410 sau unsubscribe explicit).
-- Vechea tabelă push_subscriptions rămâne pe loc (read-only, drop într-o
-- migrare viitoare după confirmarea migrării); datele sunt copiate mai jos.

BEGIN;

CREATE TABLE IF NOT EXISTS user_push_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint    text NOT NULL UNIQUE,
  p256dh      text NOT NULL,
  auth        text NOT NULL,
  platform    text NOT NULL DEFAULT 'web' CHECK (platform IN ('web', 'android', 'ios')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);

CREATE INDEX IF NOT EXISTS user_push_tokens_user_active_idx
  ON user_push_tokens (user_id)
  WHERE revoked_at IS NULL;

-- Migrează abonamentele existente (dacă tabela veche există).
INSERT INTO user_push_tokens (user_id, endpoint, p256dh, auth, platform, created_at)
SELECT ps.user_id, ps.endpoint, ps.p256dh, ps.auth, 'web', ps.created_at
  FROM push_subscriptions ps
ON CONFLICT (endpoint) DO NOTHING;

COMMIT;
