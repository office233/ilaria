-- Messenger: mesaje cu imagine fără text + raportarea unui mesaj + notificări DM
-- (w3-messenger-live). Idempotent. Nu șterge date.

-- 1) Corpul poate lipsi când mesajul are o imagine atașată.
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_body_check;
ALTER TABLE messages ADD CONSTRAINT messages_body_check
  CHECK (length(body) <= 4000 AND (length(body) >= 1 OR media_url IS NOT NULL));

-- 2) Raport pe un mesaj DM: ținta rămâne utilizatorul (constrângerea „exact o țintă”
--    din moderation_reports nu se schimbă), mesajul e context suplimentar.
ALTER TABLE moderation_reports
  ADD COLUMN IF NOT EXISTS target_message_id uuid REFERENCES messages(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS moderation_reports_target_message_idx
  ON moderation_reports (target_message_id) WHERE target_message_id IS NOT NULL;

-- 3) Notificări DM: tipul 'message' (o singură notificare necitită per conversație).
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_notification_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_notification_type_check
  CHECK (notification_type = ANY (ARRAY['follow','like','comment','reply','share','commission','system','upload_processed','creator_live','new_post','message']));
CREATE INDEX IF NOT EXISTS notifications_unread_message_conv_idx
  ON notifications (user_id, (metadata->>'conversation_id'))
  WHERE notification_type = 'message' AND read_at IS NULL;

-- 4) Link-urile vechi `/dm/<id>` (404) din notificările existente → `/messages/<id>`.
UPDATE notifications
   SET action_url = '/messages/' || substring(action_url from 5)
 WHERE action_url ~ '^/dm/[0-9a-fA-F-]{36}$';
