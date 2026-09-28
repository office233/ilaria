-- 20260730_0018_erp_seller_identity.sql
-- ERP-first sellers: cont ERP => profil seller Swypik + user mobil (rol 'seller')
-- + bifa albastra pentru firme verificate.
BEGIN;

-- 1. Rol nou 'seller' in users (firmele primesc cont de aplicatie)
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('shopper', 'creator', 'seller', 'moderator', 'admin'));

-- 2. Legatura seller <-> user + bifa albastra
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS is_verified boolean NOT NULL DEFAULT false;
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS erp_tenant_name text;

CREATE UNIQUE INDEX IF NOT EXISTS sellers_user_id_uidx
  ON sellers (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sellers_verified_idx
  ON sellers (is_verified) WHERE is_verified = true;

COMMIT;
