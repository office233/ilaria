-- 20260926_0101_admin_audit_actor
--
-- Jurnalul de audit al consolei de admin: rolul de admin al actorului la
-- momentul acțiunii + indexuri pentru filtrele din /admin/audit
-- (acțiune, actor, țintă). actor_kind primește valorile noi:
--   'admin_user'  — admin logat cu contul lui (OTP)
--   'break_glass' — admin logat cu ADMIN_SECRET + emailul lui (acces de urgență)
--   'machine'     — script/cron cu `Authorization: Bearer <ADMIN_SECRET>`
--   'erp'         — Multi-ERP prin /api/internal (INTERNAL_SECRET)
--   'admin_secret' — rânduri istorice (sesiuni anonime, dinainte de 0100)
-- Idempotent.

ALTER TABLE admin_audit_log ADD COLUMN IF NOT EXISTS actor_role text;

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_actor
  ON admin_audit_log (actor_user_id, created_at DESC)
  WHERE actor_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_action
  ON admin_audit_log (action text_pattern_ops, created_at DESC);
