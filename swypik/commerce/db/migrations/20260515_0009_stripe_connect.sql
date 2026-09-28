ALTER TABLE users
  ADD COLUMN IF NOT EXISTS stripe_connect_account_id text,
  ADD COLUMN IF NOT EXISTS stripe_connect_charges_enabled boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS stripe_connect_payouts_enabled boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS stripe_connect_details_submitted boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS stripe_connect_onboarded_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_users_stripe_connect ON users(stripe_connect_account_id) WHERE stripe_connect_account_id IS NOT NULL;
INSERT INTO schema_migrations (version, applied_at) VALUES ('20260515_0009', now()) ON CONFLICT DO NOTHING;
