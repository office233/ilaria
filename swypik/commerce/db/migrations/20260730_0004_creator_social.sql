-- ============================================================================
-- FRONT 2 — Creator social graph extras.
-- 1. users.total_likes — coloană cache pentru totalul like-urilor primite
--    (pe clipurile creatorului), întreținută prin trigger pe `likes`.
-- 2. Index pe commissions pentru agregarea GMV per creator (badge-uri).
-- Idempotent.
-- ============================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Coloană cache total_likes pe users
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS total_likes bigint NOT NULL DEFAULT 0;

-- Trigger: la INSERT/DELETE pe likes (doar like-uri de video), actualizează
-- cache-ul creatorului clipului.
CREATE OR REPLACE FUNCTION creator_total_likes_sync()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_creator uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.video_id IS NOT NULL THEN
      SELECT creator_id INTO v_creator FROM videos WHERE id = NEW.video_id;
      IF v_creator IS NOT NULL THEN
        UPDATE users SET total_likes = total_likes + 1 WHERE id = v_creator;
      END IF;
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.video_id IS NOT NULL THEN
      SELECT creator_id INTO v_creator FROM videos WHERE id = OLD.video_id;
      IF v_creator IS NOT NULL THEN
        UPDATE users SET total_likes = GREATEST(total_likes - 1, 0) WHERE id = v_creator;
      END IF;
    END IF;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_likes_creator_total_likes') THEN
    CREATE TRIGGER trg_likes_creator_total_likes
      AFTER INSERT OR DELETE ON likes
      FOR EACH ROW EXECUTE FUNCTION creator_total_likes_sync();
  END IF;
END $$;

-- Backfill (recalcul complet — sigur de rulat oricând).
UPDATE users u
SET total_likes = COALESCE(agg.cnt, 0)
FROM (
  SELECT v.creator_id, COUNT(*) AS cnt
    FROM likes l
    JOIN videos v ON v.id = l.video_id
   WHERE l.video_id IS NOT NULL
   GROUP BY v.creator_id
) agg
WHERE agg.creator_id = u.id
  AND u.total_likes IS DISTINCT FROM agg.cnt;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Index pentru GMV per creator (badge-uri bronze/silver/gold/top seller)
-- ────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS commissions_creator_status_gross_idx
  ON commissions (creator_id, status)
  INCLUDE (gross_amount_cents);

COMMIT;

INSERT INTO schema_migrations (version, applied_at)
VALUES ('20260730_0004', now())
ON CONFLICT DO NOTHING;
