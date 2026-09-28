-- 20260928_12_users_deleted_at
--
-- Ștergerea contului din aplicație (cerință App Store / Google Play + GDPR
-- art. 17): contul e anonimizat (status 'deleted') și momentul se reține aici.
-- Evidențele financiare (comenzi, facturi, plăți) rămân, fără date de contact,
-- conform obligației legale de arhivare. Detalii: docs/privacy/account-deletion.md.
--
-- Idempotent. Rollback: ALTER TABLE users DROP COLUMN IF EXISTS deleted_at;

ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE INDEX IF NOT EXISTS users_deleted_at_idx ON users (deleted_at) WHERE deleted_at IS NOT NULL;
