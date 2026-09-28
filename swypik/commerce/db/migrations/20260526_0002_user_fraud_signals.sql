-- Track normalized identity signals at user creation for recreation detection.
-- When a fraud-blocked user signs up again with email+1, dots gmail trick, or same phone/IP,
-- we can auto-block the new account.

CREATE TABLE IF NOT EXISTS user_fraud_signals (
  user_id            UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email_normalized   TEXT,          -- lowercase, gmail dots stripped, +tag stripped
  email_domain       TEXT,          -- lowercase domain
  phone_normalized   TEXT,          -- digits only, last 9-10
  signup_ip          INET,          -- IP at signup (Cloudflare cf-connecting-ip)
  signup_ip_country  TEXT,          -- cf-ipcountry
  signup_user_agent  TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Lookups: "is there a blocked user matching this email/phone/IP?"
CREATE INDEX IF NOT EXISTS idx_ufs_email_norm  ON user_fraud_signals (email_normalized) WHERE email_normalized IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ufs_phone_norm  ON user_fraud_signals (phone_normalized) WHERE phone_normalized IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ufs_signup_ip   ON user_fraud_signals (signup_ip) WHERE signup_ip IS NOT NULL;
