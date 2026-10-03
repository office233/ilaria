-- Add FK marketplace_products.taxonomy_node_slug -> taxonomy_nodes.slug
-- Verified 0 orphans before creating constraint. Idempotent (re-rulat la deploy).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'marketplace_products_taxonomy_node_slug_fkey'
      AND conrelid = 'marketplace_products'::regclass
  ) THEN
    ALTER TABLE marketplace_products
      ADD CONSTRAINT marketplace_products_taxonomy_node_slug_fkey
      FOREIGN KEY (taxonomy_node_slug) REFERENCES taxonomy_nodes(slug)
      ON UPDATE CASCADE ON DELETE SET NULL
      NOT VALID;
  END IF;
END $$;
ALTER TABLE marketplace_products VALIDATE CONSTRAINT marketplace_products_taxonomy_node_slug_fkey;
CREATE INDEX IF NOT EXISTS idx_marketplace_products_taxonomy_slug ON marketplace_products(taxonomy_node_slug);
