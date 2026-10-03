-- AI moat foundation: pgvector embeddings on marketplace_products + videos.
-- Necesită imagine postgres cu pgvector binary (pgvector/pgvector:pg16).
-- Vezi docs/pgvector-upgrade.md pentru pașii de upgrade.

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE marketplace_products
  ADD COLUMN IF NOT EXISTS embedding vector(1536),
  ADD COLUMN IF NOT EXISTS embedding_updated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_products_embedding
  ON marketplace_products USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

ALTER TABLE videos
  ADD COLUMN IF NOT EXISTS embedding vector(1536),
  ADD COLUMN IF NOT EXISTS embedding_updated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_videos_embedding
  ON videos USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
