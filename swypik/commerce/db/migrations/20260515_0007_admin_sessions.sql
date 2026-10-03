-- 20260515_0007_admin_sessions.sql
-- admin_sessions exists in code (lib/security/admin-auth.ts, app/api/auth/*) but has no DDL.
CREATE TABLE IF NOT EXISTS admin_sessions (
  token       text PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_sessions_expires_idx ON admin_sessions(expires_at);
