-- 20260926_0111_comments_pin_mentions
--
-- Comentarii: fixare de către proprietarul clipului (un singur comentariu
-- fixat per video), paginare prin cursor, notificări de tip „mention".
-- Idempotent.

ALTER TABLE comments ADD COLUMN IF NOT EXISTS pinned_at timestamptz;

-- Un singur comentariu (de nivel 1) fixat per video.
CREATE UNIQUE INDEX IF NOT EXISTS comments_one_pinned_per_video_uidx
  ON comments (video_id)
  WHERE pinned_at IS NOT NULL AND parent_comment_id IS NULL;

-- Paginare prin cursor (created_at, id) pe comentariile vizibile.
CREATE INDEX IF NOT EXISTS comments_video_visible_cursor_idx
  ON comments (video_id, created_at DESC, id DESC)
  WHERE parent_comment_id IS NULL AND status = 'visible';

CREATE INDEX IF NOT EXISTS comments_parent_visible_cursor_idx
  ON comments (parent_comment_id, created_at, id)
  WHERE parent_comment_id IS NOT NULL AND status = 'visible';

-- Tipul „mention" (@username într-un comentariu). Lărgim CHECK-ul existent —
-- nicio valoare nu se pierde (setul nou îl include pe cel vechi).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'notifications_notification_type_check'
       AND pg_get_constraintdef(oid) LIKE '%mention%'
  ) THEN
    ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_notification_type_check;
    ALTER TABLE notifications ADD CONSTRAINT notifications_notification_type_check
      CHECK (notification_type = ANY (ARRAY[
        'follow', 'like', 'comment', 'reply', 'mention', 'share', 'commission',
        'system', 'upload_processed', 'creator_live', 'new_post'
      ]::text[]));
  END IF;
END $$;
