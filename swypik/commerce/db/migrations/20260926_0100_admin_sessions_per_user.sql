-- 20260926_0100_admin_sessions_per_user
--
-- Consola de admin: sesiuni per administrator (nu mai există sesiuni anonime
-- create cu parola comună ADMIN_SECRET) + roluri de admin (RBAC).
--
--  * admin_sessions.user_id — cine e logat; sesiunea e validă doar cât timp
--    users.role = 'admin' și contul nu e suspendat (verificat la fiecare cerere).
--  * admin_sessions.kind — 'otp' (login normal cu cod pe email) sau
--    'break_glass' (ADMIN_SECRET + email de admin, doar cu
--    ADMIN_BREAK_GLASS_ENABLED=1).
--  * users.admin_role — owner | ops | finance | moderator | support.
--    Adminii existenți devin 'owner' (azi e un singur rol, cu toate drepturile).
--
-- Sesiunile vechi fără user_id (create cu parola comună) sunt expirate, nu
-- șterse. Idempotent.

ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'otp';
ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS ip text;
ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS user_agent text;
ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS revoked_at timestamptz;

DO $$ BEGIN
  ALTER TABLE admin_sessions ADD CONSTRAINT admin_sessions_kind_check
    CHECK (kind IN ('otp', 'break_glass'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS admin_sessions_user_idx
  ON admin_sessions (user_id, expires_at DESC)
  WHERE revoked_at IS NULL;

-- Sesiunile anonime (parola comună) nu mai sunt acceptate de cod; le închidem explicit.
UPDATE admin_sessions
   SET expires_at = LEAST(expires_at, now()),
       revoked_at = COALESCE(revoked_at, now())
 WHERE user_id IS NULL;

ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_role text;

DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_admin_role_check
    CHECK (admin_role IS NULL OR admin_role IN ('owner', 'ops', 'finance', 'moderator', 'support'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

UPDATE users SET admin_role = 'owner' WHERE role = 'admin' AND admin_role IS NULL;
