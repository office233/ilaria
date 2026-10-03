-- 20260928_0060_live_chat_moderation
--
-- Moderarea chatului Live (UGC — cerință App Store 1.2 / Google Play):
--   1) gazda (sau un admin) poate ascunde un mesaj → hidden_at/hidden_by; mesajele
--      ascunse nu mai apar în catch-up și sunt retrase live din clienți (event „remove”);
--   2) gazda poate bloca un utilizator pe streamul ei → live_chat_bans (nu mai
--      poate scrie; mesajele lui existente sunt ascunse);
--   3) rapoartele merg în moderation_reports (țintă = autorul, contextul în metadata).
-- Filtrul automat e Azure AI Content Safety (lib/ai/moderate.ts), la POST.
-- Idempotent. Nu șterge date.

ALTER TABLE live_chat_messages ADD COLUMN IF NOT EXISTS hidden_at timestamptz;
ALTER TABLE live_chat_messages ADD COLUMN IF NOT EXISTS hidden_by text;

CREATE INDEX IF NOT EXISTS idx_live_chat_stream_user
  ON live_chat_messages (stream_id, user_id);

CREATE TABLE IF NOT EXISTS live_chat_bans (
  stream_id  uuid NOT NULL REFERENCES live_streams(id) ON DELETE CASCADE,
  user_id    text NOT NULL,
  banned_by  text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (stream_id, user_id)
);
