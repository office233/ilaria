-- 20260514_search_indexes.sql
-- Search indexes for users (trigram) and marketplace_products (FTS).
-- Idempotent: safe to re-run.

BEGIN;

-- Trigram support for fuzzy/ILIKE acceleration on users.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Users: trigram GIN indexes on username and display_name.
CREATE INDEX IF NOT EXISTS users_username_trgm_idx
  ON users USING gin (username gin_trgm_ops);

CREATE INDEX IF NOT EXISTS users_display_name_trgm_idx
  ON users USING gin (display_name gin_trgm_ops);

-- Marketplace products: add a generated tsvector column + GIN index.
-- We can't always know if `description` exists, so probe pg_attribute and
-- choose the appropriate generation expression.
DO $$
DECLARE
  has_description boolean;
  has_search_doc  boolean;
  gen_expr        text;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    WHERE c.relname = 'marketplace_products'
      AND a.attname = 'description'
      AND a.attnum > 0
      AND NOT a.attisdropped
  ) INTO has_description;

  SELECT EXISTS (
    SELECT 1
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    WHERE c.relname = 'marketplace_products'
      AND a.attname = 'search_document'
      AND a.attnum > 0
      AND NOT a.attisdropped
  ) INTO has_search_doc;

  IF NOT has_search_doc THEN
    IF has_description THEN
      gen_expr :=
        'setweight(to_tsvector(''simple'', COALESCE(title, '''')), ''A'') || ' ||
        'setweight(to_tsvector(''simple'', COALESCE(description, '''')), ''B'')';
    ELSE
      gen_expr :=
        'setweight(to_tsvector(''simple'', COALESCE(title, '''')), ''A'')';
    END IF;

    EXECUTE format(
      'ALTER TABLE marketplace_products
         ADD COLUMN search_document tsvector
         GENERATED ALWAYS AS (%s) STORED',
      gen_expr
    );
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS marketplace_products_search_document_gin_idx
  ON marketplace_products USING gin (search_document);

-- Optional: trigram on product title for prefix/typo autocomplete.
CREATE INDEX IF NOT EXISTS marketplace_products_title_trgm_idx
  ON marketplace_products USING gin (title gin_trgm_ops);

COMMIT;
