-- 20260928_11_email_verification_tokens
--
-- Confirmarea emailului printr-un LINK (nu prin codul de login): după
-- înregistrarea cu parolă și din bannerul „confirmă emailul" se trimite un
-- token de unică folosință, valabil 24h (lib/auth/ttl.ts). Se păstrează doar
-- hash-ul SHA-256 al tokenului.
--
-- Idempotent. Rollback: DROP TABLE IF EXISTS email_verification_tokens;

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email_lower text NOT NULL,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_verification_tokens_user_idx ON email_verification_tokens (user_id);
