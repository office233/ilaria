-- FRONT 5 — moderare clipuri video.
-- Clipurile noi intra cu moderation_status='pending_review' si sunt aprobate
-- din panoul Multi-ERP prin /api/internal/moderation/{pending,decide} (type "video").
-- Existentul ramane 'approved' (backwards compatible — nu blocam feed-ul curent).
--
-- NOTA: tag-urile de produse pe clip (picker + overlay "vezi produsul" la
-- timestamp) folosesc tabela EXISTENTA video_product_links
-- (placement='overlay', start_ms/end_ms) din 20260510_0001 — nu se creeaza
-- o tabela video_product_tags duplicata.

ALTER TABLE videos
  ADD COLUMN IF NOT EXISTS moderation_status text NOT NULL DEFAULT 'approved'
    CHECK (moderation_status IN ('pending_review', 'approved', 'rejected'));

CREATE INDEX IF NOT EXISTS idx_videos_moderation_pending
  ON videos (created_at ASC)
  WHERE moderation_status = 'pending_review';
