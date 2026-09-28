-- Reconciliere: coloanele de safety existau pe vechiul VPS (migrații pre-baseline,
-- acum stub-uri inerte în db/migrations/baseline/), dar lipsesc din db/schema.sql.
-- Codul le folosește peste tot (p.effective_label = 'safe'). Idempotent.

ALTER TABLE marketplace_products
  ADD COLUMN IF NOT EXISTS effective_label text NOT NULL DEFAULT 'safe',
  ADD COLUMN IF NOT EXISTS is_adult boolean NOT NULL DEFAULT false;

ALTER TABLE videos
  ADD COLUMN IF NOT EXISTS effective_label text NOT NULL DEFAULT 'safe',
  ADD COLUMN IF NOT EXISTS is_adult boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_mp_effective_label
  ON marketplace_products (effective_label) WHERE effective_label <> 'safe';
CREATE INDEX IF NOT EXISTS idx_videos_effective_label
  ON videos (effective_label) WHERE effective_label <> 'safe';
