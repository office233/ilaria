-- 20260518_0005_email_digest.sql
-- Adds last_digest_sent_at to users for weekly email digest gating.
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_digest_sent_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS users_last_digest_idx ON users(last_digest_sent_at);
