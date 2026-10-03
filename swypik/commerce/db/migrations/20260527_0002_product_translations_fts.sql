-- product_translations FTS — per-locale search vector.
-- Uses `simple` config + f_unaccent so it's language-agnostic
-- (handles ro/en/es/fr/de/pt/it without dictionary tuning).

ALTER TABLE product_translations
  ADD COLUMN IF NOT EXISTS search_document tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', f_unaccent(COALESCE(title, ''))), 'A')
    || setweight(to_tsvector('simple', f_unaccent(COALESCE(seo_title, ''))), 'A')
    || setweight(to_tsvector('simple', f_unaccent(COALESCE(description, ''))), 'C')
    || setweight(to_tsvector('simple', f_unaccent(COALESCE(seo_description, ''))), 'C')
  ) STORED;

CREATE INDEX IF NOT EXISTS product_translations_search_gin_idx
  ON product_translations USING gin (search_document);

-- Composite index (locale, search_document) requires btree_gin
CREATE EXTENSION IF NOT EXISTS btree_gin;
CREATE INDEX IF NOT EXISTS product_translations_locale_search_idx
  ON product_translations USING gin (locale, search_document);
