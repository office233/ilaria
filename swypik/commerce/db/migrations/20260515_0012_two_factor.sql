ALTER TABLE users 
  ADD COLUMN IF NOT EXISTS totp_secret text,
  ADD COLUMN IF NOT EXISTS totp_enabled_at timestamptz,
  ADD COLUMN IF NOT EXISTS totp_backup_codes text[];
INSERT INTO schema_migrations (version, applied_at) VALUES ('20260515_0012', now()) ON CONFLICT DO NOTHING;
