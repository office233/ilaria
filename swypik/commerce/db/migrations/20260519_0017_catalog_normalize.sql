-- Migration: 20260519_0017_catalog_normalize.sql
-- Cleanup of polluted `category` column on marketplace_products.
-- The AliExpress importer wrote category as "Dept > Cat > Sub > <title fragment>"
-- yielding 4866 rows with category > 120 chars (and 153 hard-fallback
-- "Other > Misc > General > <title>" cases).
-- We rebuild category from the structured taxonomy_* fields, which are
-- already populated on every active row (13472/13472 verified).

BEGIN;

UPDATE marketplace_products
SET category = TRIM(BOTH ' >' FROM
    COALESCE(NULLIF(taxonomy_department, ''), '')
    || CASE WHEN COALESCE(taxonomy_category, '') <> '' THEN ' > ' || taxonomy_category ELSE '' END
    || CASE WHEN COALESCE(taxonomy_subcategory, '') <> '' THEN ' > ' || taxonomy_subcategory ELSE '' END
  )
WHERE char_length(COALESCE(category, '')) > 120
  AND taxonomy_department IS NOT NULL
  AND taxonomy_department <> '';

-- Guarantee no surviving long categories. If anything still > 120 (e.g. very
-- long taxonomy leaf), truncate hard.
UPDATE marketplace_products
SET category = LEFT(category, 120)
WHERE char_length(COALESCE(category, '')) > 120;

COMMIT;
