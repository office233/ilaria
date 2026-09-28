BEGIN;

DO $$
DECLARE
  status_constraint_name text;
BEGIN
  SELECT con.conname
    INTO status_constraint_name
  FROM pg_constraint con
  JOIN pg_attribute att
    ON att.attrelid = con.conrelid
   AND att.attnum = ANY (con.conkey)
  WHERE con.conrelid = 'commerce_orders'::regclass
    AND con.contype = 'c'
    AND att.attname = 'status'
  LIMIT 1;

  IF status_constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE commerce_orders DROP CONSTRAINT %I', status_constraint_name);
  END IF;

  ALTER TABLE commerce_orders
    ADD CONSTRAINT commerce_orders_status_check
    CHECK (status IN (
      'pending',
      'authorized',
      'paid',
      'fulfilled',
      'delivered',
      'return_requested',
      'cancelled',
      'refunded',
      'failed'
    ));
END $$;

INSERT INTO schema_migrations (version)
VALUES ('20260512_0007_order_ops_statuses')
ON CONFLICT (version) DO NOTHING;

COMMIT;
