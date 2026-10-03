-- Dedupe slugs per (locale, slug) by appending a short product-id suffix
-- to all but the most-recent translation for each duplicate.
WITH ranked AS (
  SELECT product_id, locale, slug,
         ROW_NUMBER() OVER (PARTITION BY locale, slug ORDER BY updated_at DESC, product_id) AS rn
    FROM product_translations
   WHERE slug IS NOT NULL AND slug <> ''
)
UPDATE product_translations pt
   SET slug = pt.slug || '-' || substr(pt.product_id::text, 1, 8),
       updated_at = NOW()
  FROM ranked r
 WHERE r.rn > 1
   AND pt.product_id = r.product_id
   AND pt.locale = r.locale;

-- Now safe to enforce uniqueness per locale on non-null slugs
CREATE UNIQUE INDEX IF NOT EXISTS product_translations_locale_slug_unique
  ON product_translations (locale, slug)
  WHERE slug IS NOT NULL AND slug <> '';
