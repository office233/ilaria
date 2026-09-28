-- Product translations for i18n / SEO localization.
-- One row per (product_id, locale). Canonical text stays in marketplace_products.
-- Reads should LEFT JOIN and fall back to canonical when the locale row is missing.

CREATE TABLE IF NOT EXISTS product_translations (
  product_id        uuid        NOT NULL REFERENCES marketplace_products(id) ON DELETE CASCADE,
  locale            text        NOT NULL,
  title             text        NOT NULL,
  description       text,
  slug              text,
  seo_title         text,
  seo_description   text,
  -- 'seller' (typed by the seller), 'llm' (machine-translated), 'manual' (admin edit).
  source            text        NOT NULL DEFAULT 'llm',
  confidence        numeric(4,3),
  model_tag         text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, locale)
);

CREATE INDEX IF NOT EXISTS product_translations_locale_slug_idx
  ON product_translations (locale, slug)
  WHERE slug IS NOT NULL;

CREATE INDEX IF NOT EXISTS product_translations_locale_idx
  ON product_translations (locale);

-- Touch updated_at on every UPDATE.
CREATE OR REPLACE FUNCTION tg_product_translations_touch_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS product_translations_touch ON product_translations;
CREATE TRIGGER product_translations_touch
  BEFORE UPDATE ON product_translations
  FOR EACH ROW EXECUTE FUNCTION tg_product_translations_touch_updated_at();

-- FTS helper: per-locale tsvector view (built lazily; query-time fallback to canonical).
-- We avoid a generated tsvector column here because pg_locale config for tsvector
-- requires fixed regconfig per row and we want flexible locale storage.
