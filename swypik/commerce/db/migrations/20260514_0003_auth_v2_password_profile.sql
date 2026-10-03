-- Auth v2: parolă + profil social complet + future-ready (Google, phone).
-- Sprint Auth v2 — 2026-05-14

-- 1. Câmpuri noi pe users
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_hash text,
  ADD COLUMN IF NOT EXISTS password_set_at timestamptz,
  ADD COLUMN IF NOT EXISTS first_name text,
  ADD COLUMN IF NOT EXISTS last_name text,
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS phone_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS email_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS auth_providers text[] NOT NULL DEFAULT ARRAY['email_otp']::text[],
  ADD COLUMN IF NOT EXISTS suspend_grace_until timestamptz;

-- 2. Constraint nou pe status pentru a permite 'pending_verification'
-- (status existing CHECK include doar active/invited/suspended/deleted)
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check;
ALTER TABLE users ADD CONSTRAINT users_status_check
  CHECK (status IN ('active', 'invited', 'suspended', 'deleted', 'pending_verification'));

-- 3. Index pentru lookup rapid pe phone (unic doar dacă există)
CREATE UNIQUE INDEX IF NOT EXISTS users_phone_uidx
  ON users (phone)
  WHERE phone IS NOT NULL;

-- 4. Index pentru job-ul de suspendare automată (cron)
CREATE INDEX IF NOT EXISTS users_suspend_grace_idx
  ON users (suspend_grace_until)
  WHERE suspend_grace_until IS NOT NULL AND email_verified_at IS NULL;

-- 5. Backfill: utilizatorii existenți care nu au verificat încă emailul
-- (toți cei care au sesiune validă acum) primesc email_verified_at = created_at,
-- ca să nu fie suspendați retroactiv. Doar conturile fără sesiune rămân unverified.
UPDATE users
SET email_verified_at = created_at
WHERE email_verified_at IS NULL
  AND email IS NOT NULL
  AND status = 'active';
