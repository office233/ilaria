-- 20260926_0113_username_aliases
--
-- Schimbarea username-ului nu mai strică linkurile vechi /u/<vechi>: numele
-- vechi rămâne alias (redirect permanent către numele curent) și e rezervat
-- pentru proprietar — alt cont nu îl poate lua (lib/social/username.ts).
-- Idempotent.

CREATE TABLE IF NOT EXISTS username_aliases (
  username_lower text PRIMARY KEY CHECK (username_lower = lower(username_lower)),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS username_aliases_user_idx ON username_aliases (user_id, created_at DESC);
