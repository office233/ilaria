CREATE TABLE IF NOT EXISTS email_unsubscribes (
  email_lower TEXT PRIMARY KEY,
  unsubscribed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason TEXT,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL
);
