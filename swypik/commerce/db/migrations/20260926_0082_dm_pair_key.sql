-- Messenger: cheie unică per pereche DM, ca două deschideri simultane să nu creeze
-- conversații duplicate (audit messenger §4). dm_key = '<uuid-min>:<uuid-max>'.
-- Duplicatele istorice (dacă există) rămân cu dm_key NULL — nu se șterge nimic.
-- Idempotent.

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS dm_key text;

WITH pairs AS (
  SELECT c.id,
         MIN(cp.user_id::text) || ':' || MAX(cp.user_id::text) AS k,
         c.created_at
    FROM conversations c
    JOIN conversation_participants cp ON cp.conversation_id = c.id
   WHERE c.kind = 'dm' AND c.dm_key IS NULL
   GROUP BY c.id, c.created_at
  HAVING COUNT(*) = 2
),
ranked AS (
  SELECT id, k, ROW_NUMBER() OVER (PARTITION BY k ORDER BY created_at, id) AS rn
    FROM pairs
)
UPDATE conversations c
   SET dm_key = r.k
  FROM ranked r
 WHERE c.id = r.id
   AND r.rn = 1
   AND NOT EXISTS (SELECT 1 FROM conversations x WHERE x.dm_key = r.k);

CREATE UNIQUE INDEX IF NOT EXISTS conversations_dm_key_uniq
  ON conversations (dm_key) WHERE dm_key IS NOT NULL;
