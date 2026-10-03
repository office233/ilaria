-- Backfill orphan customers (no matching user by email) into users table
-- Idempotent: ON CONFLICT no-op
INSERT INTO users (external_auth_id, username, display_name, email, locale, role, metadata)
SELECT
  'customer:' || c.id::text,
  'shopper_' || substr(replace(c.id::text, '-', ''), 1, 12),
  COALESCE(c.name, c.email, 'Shopper'),
  c.email,
  'ro',
  'shopper',
  jsonb_build_object('source', 'customer_backfill', 'customer_id', c.id)
FROM customers c
LEFT JOIN users u ON lower(u.email) = lower(c.email)
WHERE u.id IS NULL AND c.email IS NOT NULL
ON CONFLICT (external_auth_id) WHERE external_auth_id IS NOT NULL DO NOTHING;
