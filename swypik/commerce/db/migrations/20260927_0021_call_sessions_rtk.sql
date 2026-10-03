-- Apeluri Messenger pe Cloudflare RealtimeKit (w5-realtime).
--  * provider: 'cf_rtk' pentru apelurile noi; 'livekit' pentru rândurile vechi.
--  * rtk_meeting_id: meeting-ul RealtimeKit (unul per apel), cheia webhook-urilor.
--  * livekit_room_name rămâne (NOT NULL UNIQUE) și primește în continuare o cheie
--    unică (`swypik_call_<uuid>`), folosită și ca titlu al meeting-ului.
-- Idempotent.

ALTER TABLE call_sessions ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'livekit';
ALTER TABLE call_sessions ADD COLUMN IF NOT EXISTS rtk_meeting_id text;

ALTER TABLE call_sessions DROP CONSTRAINT IF EXISTS call_sessions_provider_check;
ALTER TABLE call_sessions ADD CONSTRAINT call_sessions_provider_check
  CHECK (provider IN ('livekit', 'cf_rtk'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_call_sessions_rtk_meeting
  ON call_sessions (rtk_meeting_id) WHERE rtk_meeting_id IS NOT NULL;
