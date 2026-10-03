-- Cache for AliExpress full category chains discovered via text.search
CREATE TABLE IF NOT EXISTS ae_category_full_chain (
  leaf_id           BIGINT PRIMARY KEY,
  chain_ids         BIGINT[] NOT NULL,
  chain_names_en    TEXT[]   NOT NULL DEFAULT '{}',
  chain_names_ro    TEXT[]   NOT NULL DEFAULT '{}',
  depth             SMALLINT NOT NULL,
  root_id           BIGINT   NOT NULL,
  source            TEXT     NOT NULL DEFAULT 'text.search',
  discovered_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ae_chain_root ON ae_category_full_chain(root_id);
CREATE INDEX IF NOT EXISTS idx_ae_chain_ids_gin ON ae_category_full_chain USING GIN (chain_ids);

-- Mark products that we couldn't confidently map to internal taxonomy
ALTER TABLE marketplace_products
  ADD COLUMN IF NOT EXISTS taxonomy_unresolved BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_mp_taxonomy_unresolved
  ON marketplace_products(taxonomy_unresolved) WHERE taxonomy_unresolved = true;