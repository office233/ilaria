-- Shopify mandatory privacy/compliance webhook audit.

BEGIN;

CREATE TABLE IF NOT EXISTS seller_shopify_privacy_requests (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id            uuid REFERENCES sellers(id) ON DELETE SET NULL,
  shop                  text NOT NULL,
  topic                 text NOT NULL CHECK (
                         topic IN ('customers/data_request', 'customers/redact', 'shop/redact')
                       ),
  external_request_id   text NOT NULL,
  customer_external_id  text,
  order_external_ids    jsonb NOT NULL DEFAULT '[]'::jsonb,
  status                text NOT NULL DEFAULT 'received'
                        CHECK (status IN ('received', 'completed', 'failed')),
  payload_sha256        char(64) NOT NULL,
  error_code            text,
  due_at                timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  processed_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop, topic, external_request_id)
);

CREATE INDEX IF NOT EXISTS idx_shopify_privacy_requests_due
  ON seller_shopify_privacy_requests (status, due_at)
  WHERE status <> 'completed';

COMMIT;
