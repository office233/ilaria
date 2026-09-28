-- Idempotența webhook-urilor Cloudflare RealtimeKit (w5-realtime): fiecare
-- livrare are un `rtk-uuid` unic; o reîncercare cu același id e ignorată.
-- Idempotent.

CREATE TABLE IF NOT EXISTS realtime_webhook_deliveries (
  delivery_id  text PRIMARY KEY,
  provider     text NOT NULL DEFAULT 'cf_rtk',
  event        text NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_realtime_webhook_deliveries_received
  ON realtime_webhook_deliveries (received_at);
