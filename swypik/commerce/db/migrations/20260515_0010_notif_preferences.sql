CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email_likes boolean NOT NULL DEFAULT true,
  email_comments boolean NOT NULL DEFAULT true,
  email_follows boolean NOT NULL DEFAULT true,
  email_messages boolean NOT NULL DEFAULT true,
  email_sales boolean NOT NULL DEFAULT true,
  email_marketing boolean NOT NULL DEFAULT false,
  push_likes boolean NOT NULL DEFAULT true,
  push_comments boolean NOT NULL DEFAULT true,
  push_follows boolean NOT NULL DEFAULT true,
  push_messages boolean NOT NULL DEFAULT true,
  push_sales boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO schema_migrations (version, applied_at) VALUES ('20260515_0010', now()) ON CONFLICT DO NOTHING;
