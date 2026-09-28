-- 20260926_0110_social_counter_triggers
--
-- Contoarele sociale denormalizate sunt ținute de TRIGGERE, nu de fiecare rută
-- (audit profiles-social: drift între `videos.comment_count` și foaia de
-- comentarii; like-uri scăzute de două ori la merge-anon; Go platform-api
-- inserează comentarii fără să atingă contorul).
--
--   likes (video)   → videos.like_count
--   likes (comment) → comments.like_count
--   comments        → videos.comment_count  (doar status = 'visible', inclusiv răspunsuri)
--                   → comments.reply_count  (răspunsuri 'visible' ale părintelui)
--
-- Codul aplicației NU mai incrementează/decrementează aceste coloane (vezi
-- lib/social/likes.ts, lib/social/comments/*). `social_resync_counters()`
-- recalculează totul din sursă — rulat o dată aici (backfill) și reapelabil
-- oricând (ex. după fereastra de deploy în care codul vechi încă număra manual).
-- Idempotent.

CREATE OR REPLACE FUNCTION social_likes_counter() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.video_id IS NOT NULL THEN
      UPDATE videos SET like_count = like_count + 1 WHERE id = NEW.video_id;
    ELSIF NEW.comment_id IS NOT NULL THEN
      UPDATE comments SET like_count = like_count + 1 WHERE id = NEW.comment_id;
    END IF;
    RETURN NEW;
  END IF;
  -- DELETE
  IF OLD.video_id IS NOT NULL THEN
    UPDATE videos SET like_count = GREATEST(like_count - 1, 0) WHERE id = OLD.video_id;
  ELSIF OLD.comment_id IS NOT NULL THEN
    UPDATE comments SET like_count = GREATEST(like_count - 1, 0) WHERE id = OLD.comment_id;
  END IF;
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION social_comments_counter() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_counted boolean := false;
  new_counted boolean := false;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    old_counted := OLD.status = 'visible';
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    new_counted := NEW.status = 'visible';
  END IF;

  IF old_counted THEN
    UPDATE videos SET comment_count = GREATEST(comment_count - 1, 0) WHERE id = OLD.video_id;
    IF OLD.parent_comment_id IS NOT NULL THEN
      UPDATE comments SET reply_count = GREATEST(reply_count - 1, 0) WHERE id = OLD.parent_comment_id;
    END IF;
  END IF;

  IF new_counted THEN
    UPDATE videos SET comment_count = comment_count + 1 WHERE id = NEW.video_id;
    IF NEW.parent_comment_id IS NOT NULL THEN
      UPDATE comments SET reply_count = reply_count + 1 WHERE id = NEW.parent_comment_id;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_likes_social_counter') THEN
    CREATE TRIGGER trg_likes_social_counter
      AFTER INSERT OR DELETE ON likes
      FOR EACH ROW EXECUTE FUNCTION social_likes_counter();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_comments_social_counter') THEN
    CREATE TRIGGER trg_comments_social_counter
      AFTER INSERT OR DELETE OR UPDATE OF status, parent_comment_id, video_id ON comments
      FOR EACH ROW EXECUTE FUNCTION social_comments_counter();
  END IF;
END $$;

-- Recalculare completă din tabelele-sursă. Atinge doar rândurile în drift.
CREATE OR REPLACE FUNCTION social_resync_counters() RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  n integer := 0;
  c integer;
BEGIN
  WITH truth AS (
    SELECT v.id,
           (SELECT COUNT(*) FROM likes l WHERE l.video_id = v.id) AS likes,
           (SELECT COUNT(*) FROM comments cm WHERE cm.video_id = v.id AND cm.status = 'visible') AS comments
      FROM videos v
  )
  UPDATE videos v
     SET like_count = t.likes, comment_count = t.comments
    FROM truth t
   WHERE v.id = t.id AND (v.like_count <> t.likes OR v.comment_count <> t.comments);
  GET DIAGNOSTICS c = ROW_COUNT; n := n + c;

  WITH truth AS (
    SELECT cm.id,
           (SELECT COUNT(*) FROM likes l WHERE l.comment_id = cm.id) AS likes,
           (SELECT COUNT(*) FROM comments r WHERE r.parent_comment_id = cm.id AND r.status = 'visible') AS replies
      FROM comments cm
  )
  UPDATE comments cm
     SET like_count = t.likes, reply_count = t.replies
    FROM truth t
   WHERE cm.id = t.id AND (cm.like_count <> t.likes OR cm.reply_count <> t.replies);
  GET DIAGNOSTICS c = ROW_COUNT; n := n + c;

  -- users.total_likes (ținut de trg_likes_creator_total_likes) — același drift.
  WITH truth AS (
    SELECT u.id,
           (SELECT COUNT(*) FROM likes l JOIN videos v ON v.id = l.video_id WHERE v.creator_id = u.id) AS likes
      FROM users u
  )
  UPDATE users u
     SET total_likes = t.likes
    FROM truth t
   WHERE u.id = t.id AND u.total_likes <> t.likes;
  GET DIAGNOSTICS c = ROW_COUNT; n := n + c;

  RETURN n;
END;
$$;

SELECT social_resync_counters();
