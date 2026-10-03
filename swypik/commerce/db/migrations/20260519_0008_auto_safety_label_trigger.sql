-- Migration 0008: auto-label new products as 'sensitive' (fail-closed) on insert.
-- A JS classifier will re-process and downgrade to 'safe' or upgrade to 'adult'/'blocked'.

CREATE OR REPLACE FUNCTION auto_create_safety_label()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO product_safety_labels (
    product_id, label, classifier_version, reasons, signals
  ) VALUES (
    NEW.id,
    'sensitive',
    'auto_pending',
    ARRAY['pending_classification']::text[],
    '{"pending": true}'::jsonb
  )
  ON CONFLICT (product_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_marketplace_products_auto_safety ON marketplace_products;
CREATE TRIGGER trg_marketplace_products_auto_safety
  AFTER INSERT ON marketplace_products
  FOR EACH ROW
  EXECUTE FUNCTION auto_create_safety_label();

COMMENT ON FUNCTION auto_create_safety_label() IS
'Inserts a fail-closed "sensitive" safety label on every new product so untriaged items are hidden by default until classified.';

INSERT INTO schema_migrations (version) VALUES ('20260519_0008_auto_safety_label_trigger')
ON CONFLICT (version) DO NOTHING;
