-- Add verified badge column to users
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_verified boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS users_verified_idx ON users(id) WHERE is_verified = true;

-- Add monetizable flag to videos (only creators with Stripe Connect get commissions)
ALTER TABLE videos ADD COLUMN IF NOT EXISTS is_monetizable boolean NOT NULL DEFAULT false;

INSERT INTO schema_migrations (version, applied_at) VALUES ('20260514_0004', now()) ON CONFLICT DO NOTHING;
