-- 20260926_0112_user_blocks_privacy
--
-- Blocare utilizatori + setarea de confidențialitate a tab-ului „Apreciate".
-- O blocare ascunde reciproc comentariile, interzice follow/comentarii/
-- mențiuni/notificări între cei doi (verificat în lib/social/blocks.ts).
-- Contul privat (cereri de follow) NU e inclus — decizie de produs amânată.
-- Idempotent.

CREATE TABLE IF NOT EXISTS user_blocks (
  blocker_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_user_id, blocked_user_id),
  CONSTRAINT user_blocks_not_self CHECK (blocker_user_id <> blocked_user_id)
);

CREATE INDEX IF NOT EXISTS user_blocks_blocked_idx ON user_blocks (blocked_user_id);

-- Tab-ul „Apreciate" de pe profilul public: implicit privat.
ALTER TABLE users ADD COLUMN IF NOT EXISTS liked_videos_public boolean NOT NULL DEFAULT false;

-- Rapoarte pe utilizatori/comentarii: un singur raport deschis per reporter și
-- țintă. Dacă există deja duplicate istorice, indexul e sărit (fără eșec) —
-- ruta folosește oricum ON CONFLICT DO NOTHING + verificare prealabilă.
DO $$
BEGIN
  BEGIN
    CREATE UNIQUE INDEX IF NOT EXISTS moderation_reports_open_user_uidx
      ON moderation_reports (reporter_user_id, target_user_id)
      WHERE status = 'open' AND target_user_id IS NOT NULL AND reporter_user_id IS NOT NULL;
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'moderation_reports_open_user_uidx skipped: duplicate open reports';
  END;
  BEGIN
    CREATE UNIQUE INDEX IF NOT EXISTS moderation_reports_open_comment_uidx
      ON moderation_reports (reporter_user_id, target_comment_id)
      WHERE status = 'open' AND target_comment_id IS NOT NULL AND reporter_user_id IS NOT NULL;
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'moderation_reports_open_comment_uidx skipped: duplicate open reports';
  END;
END $$;
