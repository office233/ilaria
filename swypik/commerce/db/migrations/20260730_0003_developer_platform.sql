-- ============================================================================
-- FRONT 4 — Platforma pentru dezvoltatori (App Store + OAuth2 + Webhooks).
-- Idempotent.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. DEVELOPER ACCOUNTS — conturi dezvoltatori (aprobare din ERP, moderare)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS developer_accounts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company     text NOT NULL,
  website     text,
  status      text NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS idx_developer_accounts_status
  ON developer_accounts (status) WHERE status = 'pending';

-- ────────────────────────────────────────────────────────────────────────────
-- 2. APPS — aplicații create de dezvoltatori
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS apps (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  developer_id              uuid NOT NULL REFERENCES developer_accounts(id) ON DELETE CASCADE,
  name                      text NOT NULL,
  slug                      text NOT NULL UNIQUE,
  description               text,
  icon_url                  text,
  scopes                    text[] NOT NULL DEFAULT '{}',
  webhook_url               text,
  oauth_client_id           text NOT NULL UNIQUE,
  oauth_client_secret_hash  text NOT NULL,
  status                    text NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft', 'review', 'published')),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_apps_developer ON apps (developer_id);
CREATE INDEX IF NOT EXISTS idx_apps_published ON apps (status) WHERE status = 'published';

-- ────────────────────────────────────────────────────────────────────────────
-- 3. APP INSTALLS — instalări per seller, cu scopes acordate + token API
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_installs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id          uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  seller_id       uuid NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  granted_scopes  text[] NOT NULL DEFAULT '{}',
  api_token_hash  text UNIQUE,
  installed_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_app_installs_active
  ON app_installs (app_id, seller_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_app_installs_seller ON app_installs (seller_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 4. OAUTH CODES — coduri de autorizare temporare (exchange code → token)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_oauth_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash   text NOT NULL UNIQUE,
  app_id      uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  seller_id   uuid NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  scopes      text[] NOT NULL DEFAULT '{}',
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ────────────────────────────────────────────────────────────────────────────
-- 5. WEBHOOK DELIVERIES — log livrări webhooks către apps
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_webhook_deliveries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id       uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  install_id   uuid REFERENCES app_installs(id) ON DELETE SET NULL,
  event        text NOT NULL,
  status_code  int,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_app_webhook_deliveries_app
  ON app_webhook_deliveries (app_id, created_at DESC);
