-- 20260928_10_pending_signups
--
-- Login cu cod pe email pentru o adresă FĂRĂ cont: până acum `login` crea
-- imediat un rând în `users` (rol creator, locale 'ro'), chiar dacă emailul nu
-- era confirmat și chiar dacă trimiterea eșua. Acum codul se ține aici, iar
-- contul se creează abia la `verify_otp` (posesia emailului e dovedită).
--
-- Idempotent. Fără BEGIN/COMMIT (scripts/db/apply-migration.sh învelește
-- fișierul într-o tranzacție). Rollback: DROP TABLE IF EXISTS pending_signups;

CREATE TABLE IF NOT EXISTS pending_signups (
  email_lower  text PRIMARY KEY,
  otp_hash     text NOT NULL,
  locale       text NOT NULL DEFAULT 'ro',
  attempts     integer NOT NULL DEFAULT 0,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pending_signups_expires_idx ON pending_signups (expires_at);
