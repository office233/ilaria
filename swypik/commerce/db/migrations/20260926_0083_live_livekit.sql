-- Live pe LiveKit Cloud (w3-messenger-live, audit live §6.1–2).
--  * provider: 'livekit' pentru streamurile noi; 'rtmp' = moștenire MediaMTX.
--  * hls_url/rtmp_url care indică spre /hls/live/... (404 prin Cloudflare Tunnel)
--    se golesc, ca nicio pagină să nu mai încerce să le redea. Nu se șterge niciun stream.
-- Idempotent.

ALTER TABLE live_streams ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'rtmp';
ALTER TABLE live_streams DROP CONSTRAINT IF EXISTS live_streams_provider_check;
ALTER TABLE live_streams ADD CONSTRAINT live_streams_provider_check
  CHECK (provider IN ('rtmp', 'livekit'));

UPDATE live_streams
   SET hls_url = NULL, rtmp_url = NULL
 WHERE hls_url LIKE '%/hls/live/%';

CREATE INDEX IF NOT EXISTS idx_live_status_started
  ON live_streams (status, started_at DESC);
