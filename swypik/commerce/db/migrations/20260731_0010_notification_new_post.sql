-- Notificare 'new_post': fan-out catre followers cand un clip e aprobat.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_notification_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_notification_type_check
  CHECK (notification_type = ANY (ARRAY['follow','like','comment','reply','share','commission','system','upload_processed','creator_live','new_post']));
