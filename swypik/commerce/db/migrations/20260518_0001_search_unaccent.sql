-- 20260518_0001_search_unaccent.sql
-- Add unaccent + pg_trgm to make search RO-friendly (diacritics) with fuzzy fallback.
-- Recreates search_document tsvector via an IMMUTABLE unaccent wrapper so it can be
-- used inside GENERATED ALWAYS AS ... STORED columns.

BEGIN;

CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- IMMUTABLE wrapper around unaccent() so generated columns accept it.
CREATE OR REPLACE FUNCTION public.f_unaccent(text)
  RETURNS text
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  STRICT
AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;

-- ----- marketplace_products.search_document -----
ALTER TABLE marketplace_products DROP COLUMN IF EXISTS search_document;
ALTER TABLE marketplace_products
  ADD COLUMN search_document tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', public.f_unaccent(coalesce(title, ''))), 'A') ||
    setweight(to_tsvector('simple', public.f_unaccent(coalesce(brand, ''))), 'B') ||
    setweight(to_tsvector('simple', public.f_unaccent(coalesce(category, ''))), 'B') ||
    setweight(to_tsvector('simple', public.f_unaccent(coalesce(description, ''))), 'C')
  ) STORED;

CREATE INDEX IF NOT EXISTS marketplace_products_search_document_gin_idx
  ON marketplace_products USING gin (search_document);

-- Trigram indexes for fuzzy fallback
CREATE INDEX IF NOT EXISTS marketplace_products_title_trgm_idx
  ON marketplace_products USING gin (public.f_unaccent(lower(title)) gin_trgm_ops);

-- ----- videos.search_document -----
ALTER TABLE videos DROP COLUMN IF EXISTS search_document;
ALTER TABLE videos
  ADD COLUMN search_document tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', public.f_unaccent(coalesce(title, ''))), 'A') ||
    setweight(to_tsvector('simple', public.f_unaccent(coalesce(description, ''))), 'B')
  ) STORED;

CREATE INDEX IF NOT EXISTS videos_search_document_gin_idx
  ON videos USING gin (search_document);

CREATE INDEX IF NOT EXISTS videos_title_trgm_idx
  ON videos USING gin (public.f_unaccent(lower(title)) gin_trgm_ops);

INSERT INTO schema_migrations(version)
  VALUES ('20260518_0001_search_unaccent')
  ON CONFLICT (version) DO NOTHING;

COMMIT;
