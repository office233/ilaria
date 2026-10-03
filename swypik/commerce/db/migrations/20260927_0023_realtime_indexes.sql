-- Indexuri pentru w5-realtime. Idempotent.
--  * sweep-ul Live (heartbeat-ul gazdei expirat) caută doar streamurile SFU live;
--  * webhook-ul RealtimeKit scrie prezența în call_participants (tabel existent
--    din 20260924_0001, nefolosit până acum) — PK-ul (call_id, user_id) acoperă upsert-ul.

CREATE INDEX IF NOT EXISTS idx_live_streams_sfu_live
  ON live_streams (started_at)
  WHERE provider = 'cf_sfu' AND status = 'live';
