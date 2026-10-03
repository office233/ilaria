-- Live pe Cloudflare Realtime SFU (w5-realtime): LiveKit a fost scos.
--  * provider: 'cf_sfu' pentru streamurile noi; 'livekit'/'rtmp' rămân pentru rândurile vechi.
--  * sfu_session_id / sfu_tracks: sesiunea SFU a gazdei și track-urile publicate
--    (spectatorii le trag prin API-ul nostru; App Secret-ul nu iese din server).
--  * sfu_published_at: momentul ultimei publicări reușite.
-- Idempotent.

ALTER TABLE live_streams ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'rtmp';
ALTER TABLE live_streams ADD COLUMN IF NOT EXISTS sfu_session_id text;
ALTER TABLE live_streams ADD COLUMN IF NOT EXISTS sfu_tracks jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE live_streams ADD COLUMN IF NOT EXISTS sfu_published_at timestamptz;

ALTER TABLE live_streams DROP CONSTRAINT IF EXISTS live_streams_provider_check;
ALTER TABLE live_streams ADD CONSTRAINT live_streams_provider_check
  CHECK (provider IN ('rtmp', 'livekit', 'cf_sfu'));
