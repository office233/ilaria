-- Reliable external-commerce webhooks + background sync queue.

BEGIN;

ALTER TABLE seller_catalog_integrations
  ADD COLUMN IF NOT EXISTS webhook_secret_enc text,
  ADD COLUMN IF NOT EXISTS webhook_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS webhook_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS webhooks_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_reconcile_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_reconcile_error_code text;

DO $$ BEGIN
  ALTER TABLE seller_catalog_integrations
    ADD CONSTRAINT seller_catalog_integrations_webhook_status_check
    CHECK (webhook_status IN ('pending', 'active', 'degraded', 'unavailable'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS seller_integration_webhook_events (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id       uuid NOT NULL REFERENCES seller_catalog_integrations(id) ON DELETE CASCADE,
  provider             text NOT NULL CHECK (provider IN ('shopify', 'woocommerce')),
  delivery_id          text NOT NULL,
  topic                text NOT NULL,
  resource             text NOT NULL CHECK (resource IN ('product', 'customer', 'order')),
  action               text NOT NULL CHECK (action IN ('create', 'update', 'delete')),
  external_resource_id text,
  payload_sha256       text NOT NULL,
  triggered_at         timestamptz,
  status               text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  attempts             integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at      timestamptz NOT NULL DEFAULT now(),
  locked_by            text,
  lease_expires_at     timestamptz,
  last_error_code      text,
  received_at          timestamptz NOT NULL DEFAULT now(),
  processed_at         timestamptz,
  UNIQUE (integration_id, provider, delivery_id)
);

CREATE INDEX IF NOT EXISTS idx_seller_integration_events_ready
  ON seller_integration_webhook_events (status, next_attempt_at, received_at)
  WHERE status IN ('pending', 'failed');

CREATE INDEX IF NOT EXISTS idx_seller_integration_events_integration
  ON seller_integration_webhook_events (integration_id, received_at DESC);

COMMIT;
