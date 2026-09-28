-- Jurnal de audit pentru acțiunile din panoul de admin (cine, ce, asupra cărui obiect, când).
-- Scris de lib/security/admin-audit.ts; niciodată actualizat sau șters din aplicație.
CREATE TABLE IF NOT EXISTS admin_audit_log (
    id           BIGSERIAL PRIMARY KEY,
    actor_user_id UUID NULL,
    actor_kind   TEXT NOT NULL,              -- 'admin_user' | 'admin_secret'
    action       TEXT NOT NULL,              -- ex. 'order.refund', 'user.role_change'
    target_type  TEXT NULL,
    target_id    TEXT NULL,
    details      JSONB NOT NULL DEFAULT '{}'::jsonb,
    ip           TEXT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created ON admin_audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_target ON admin_audit_log (target_type, target_id);
