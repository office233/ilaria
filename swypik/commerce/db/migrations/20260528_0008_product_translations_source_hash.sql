-- Agent D 2026-05-28: enable stale re-translation detection.
-- Stores a short SHA-256 prefix of (title + description) at translate time.
-- A re-translate job picks any row where source_content_hash != current hash
-- of the source product, which means the source moved since the LLM ran.
--
-- Backfill strategy: existing rows get NULL → re-translate worker treats NULL
-- as stale and will pick them up gradually. That's intentional — 70% of RO
-- translations were already stale at baseline (28.483/40.656).

BEGIN;

ALTER TABLE product_translations
  ADD COLUMN IF NOT EXISTS source_content_hash TEXT;

-- Partial index for "find rows that need re-translate" — NULLs only.
-- Once worker writes a hash, the row drops out of this index.
CREATE INDEX IF NOT EXISTS product_translations_null_hash_idx
  ON product_translations (locale, product_id)
  WHERE source_content_hash IS NULL;

COMMIT;
