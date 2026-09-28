-- Onboarding flag for new users
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_completed_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_users_onboarding ON users(id) WHERE onboarding_completed_at IS NULL;

-- Backfill: existing accounts created before today should not see the onboarding modal
UPDATE users SET onboarding_completed_at = created_at WHERE onboarding_completed_at IS NULL AND created_at < '2026-05-15';

INSERT INTO schema_migrations (version, applied_at) VALUES ('20260515_0008', now()) ON CONFLICT DO NOTHING;
