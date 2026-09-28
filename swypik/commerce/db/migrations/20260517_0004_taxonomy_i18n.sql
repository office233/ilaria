-- 20260517_0001_taxonomy_i18n.sql
-- Canonical hierarchical taxonomy with multi-locale labels.
-- Replaces the hardcoded ROOT_CONSOLIDATION map in lib/db/product-queries.ts.
--
-- Structure:
--   taxonomy_nodes        — pure tree (slug PK, parent_slug FK, kind, sort_order)
--   taxonomy_translations — per-locale labels for each node (one row per locale)
--   marketplace_products.taxonomy_node_slug — leaf node assignment
--
-- All "canonical" identifiers live in slug (lowercase, kebab, language-neutral
-- where possible: e.g. "fashion", "fashion-men", "fashion-men-tshirts").
-- Display label is always looked up via taxonomy_translations with fallback to 'en'.

BEGIN;

CREATE TABLE IF NOT EXISTS taxonomy_nodes (
  slug          TEXT PRIMARY KEY,
  parent_slug   TEXT REFERENCES taxonomy_nodes(slug) ON DELETE RESTRICT,
  kind          TEXT NOT NULL CHECK (kind IN ('department', 'category', 'subcategory', 'leaf')),
  sort_order    INTEGER NOT NULL DEFAULT 100,
  ae_root_ids   TEXT[] NOT NULL DEFAULT '{}',   -- AliExpress root category IDs that map here
  ae_leaf_ids   TEXT[] NOT NULL DEFAULT '{}',   -- AliExpress leaf category IDs that map here
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  metadata      JSONB   NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS taxonomy_nodes_parent_idx ON taxonomy_nodes(parent_slug);
CREATE INDEX IF NOT EXISTS taxonomy_nodes_kind_idx   ON taxonomy_nodes(kind);
CREATE INDEX IF NOT EXISTS taxonomy_nodes_ae_root_gin ON taxonomy_nodes USING GIN (ae_root_ids);
CREATE INDEX IF NOT EXISTS taxonomy_nodes_ae_leaf_gin ON taxonomy_nodes USING GIN (ae_leaf_ids);

CREATE TABLE IF NOT EXISTS taxonomy_translations (
  node_slug   TEXT NOT NULL REFERENCES taxonomy_nodes(slug) ON DELETE CASCADE,
  locale      TEXT NOT NULL,                 -- BCP-47: 'en', 'ro', 'de', 'fr', ...
  label       TEXT NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (node_slug, locale)
);

CREATE INDEX IF NOT EXISTS taxonomy_translations_locale_idx ON taxonomy_translations(locale);

-- Soft FK (no constraint to avoid migration headaches for legacy rows).
ALTER TABLE marketplace_products
  ADD COLUMN IF NOT EXISTS taxonomy_node_slug TEXT;

CREATE INDEX IF NOT EXISTS marketplace_products_taxonomy_node_idx
  ON marketplace_products(taxonomy_node_slug)
  WHERE taxonomy_node_slug IS NOT NULL;

-- updated_at trigger
CREATE OR REPLACE FUNCTION tg_taxonomy_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS taxonomy_nodes_touch ON taxonomy_nodes;
CREATE TRIGGER taxonomy_nodes_touch BEFORE UPDATE ON taxonomy_nodes
  FOR EACH ROW EXECUTE FUNCTION tg_taxonomy_touch_updated_at();

DROP TRIGGER IF EXISTS taxonomy_translations_touch ON taxonomy_translations;
CREATE TRIGGER taxonomy_translations_touch BEFORE UPDATE ON taxonomy_translations
  FOR EACH ROW EXECUTE FUNCTION tg_taxonomy_touch_updated_at();

COMMIT;
