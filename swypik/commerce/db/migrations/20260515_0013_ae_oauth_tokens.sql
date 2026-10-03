-- AliExpress OAuth tokens storage (one row per app/account)
CREATE TABLE IF NOT EXISTS ae_oauth_tokens (
  id BIGSERIAL PRIMARY KEY,
  app_key TEXT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at TIMESTAMPTZ,
  obtained_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw JSONB,
  UNIQUE(app_key)
);
