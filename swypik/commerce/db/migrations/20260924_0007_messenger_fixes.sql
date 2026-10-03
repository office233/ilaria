-- 20260924_0007_messenger_fixes.sql
-- Wires the WhatsApp-style Messenger UI to the real DM/call backend.
-- No new tables — only indexes supporting the new incoming-call poll and
-- the ringing-call expiry sweep (both added in lib/messenger/calls.ts).

BEGIN;

-- Incoming-call polling: "ringing calls in my conversations, not started by me"
-- (app/api/messenger/calls/incoming). Partial index keeps it cheap since most
-- call_sessions rows are not 'ringing'.
CREATE INDEX IF NOT EXISTS idx_call_sessions_ringing
  ON call_sessions (conversation_id, started_at DESC)
  WHERE status = 'ringing';

-- Stale-ringing sweep (lib/messenger/calls.ts#expireStaleRingingCalls),
-- run on every incoming/join/decline call.
CREATE INDEX IF NOT EXISTS idx_call_sessions_status_started
  ON call_sessions (status, started_at)
  WHERE status = 'ringing';

COMMIT;
