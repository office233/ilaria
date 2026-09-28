-- Supplier webhook idempotency tracking
-- Ensures the same (supplier, order, tracking_number) tuple cannot fulfill twice.

CREATE TABLE IF NOT EXISTS supplier_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id text NOT NULL,
  external_order_id text NOT NULL,
  tracking_number text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS supplier_webhook_events_uidx
  ON supplier_webhook_events (supplier_id, external_order_id, tracking_number);

CREATE INDEX IF NOT EXISTS supplier_webhook_events_supplier_idx
  ON supplier_webhook_events (supplier_id, created_at DESC);
