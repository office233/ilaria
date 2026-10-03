-- Canonical UUID identity for Live stream creators.
-- The legacy TEXT column remains temporarily for safe rollout / orphan audit.

BEGIN;

ALTER TABLE live_streams
  ADD COLUMN IF NOT EXISTS creator_user_id uuid;

UPDATE live_streams ls
   SET creator_user_id = u.id
  FROM users u
 WHERE ls.creator_user_id IS NULL
   AND ls.creator_id = u.id::text;

CREATE INDEX IF NOT EXISTS idx_live_creator_user
  ON live_streams (creator_user_id)
  WHERE creator_user_id IS NOT NULL;

DO $$ BEGIN
  ALTER TABLE live_streams
    ADD CONSTRAINT live_streams_creator_user_id_fkey
    FOREIGN KEY (creator_user_id) REFERENCES users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Enforced for NEW/UPDATED rows, while NOT VALID avoids blocking deployment
-- on historical orphan rows. Ended/failed legacy rows may remain null until
-- the cleanup migration drops creator_id TEXT.
DO $$ BEGIN
  ALTER TABLE live_streams
    ADD CONSTRAINT live_streams_active_creator_uuid_check
    CHECK (creator_user_id IS NOT NULL OR status IN ('ended', 'failed'))
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMIT;
