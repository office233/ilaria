-- Shopify OAuth authorization-code flow for seller-owned stores.
-- State is one-time, short-lived and bound to the Swypik seller initiating it.

BEGIN;

CREATE TABLE IF NOT EXISTS seller_shopify_oauth_states (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id   uuid NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  shop        text NOT NULL,
  state_hash  char(64) NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_seller_shopify_oauth_states_expires
  ON seller_shopify_oauth_states (expires_at);

COMMIT;
