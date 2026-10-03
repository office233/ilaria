-- Hardening chei ERP seller (2026-09-26, w1-security):
--   erp_api_key era stocată și comparată în clar (și folosită ca bearer de partner).
--   * erp_api_key_hash — sha256 hex, folosit la autentificarea /api/partner;
--   * erp_api_key_enc  — AES-256-GCM (cheie din APP_ENCRYPTION_KEY), folosit la
--     apelurile către ERP-ul seller-ului. Se completează din aplicație (migrare
--     leneșă la prima folosire), fiindcă SQL nu are cheia aplicației.
-- Coloana veche NU se șterge; aplicația o golește după migrarea fiecărei chei.
-- Idempotent.

BEGIN;

ALTER TABLE sellers ADD COLUMN IF NOT EXISTS erp_api_key_hash text;
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS erp_api_key_enc text;

UPDATE sellers
   SET erp_api_key_hash = encode(sha256(convert_to(erp_api_key, 'UTF8')), 'hex')
 WHERE erp_api_key IS NOT NULL
   AND erp_api_key_hash IS NULL;

CREATE INDEX IF NOT EXISTS idx_sellers_erp_api_key_hash
  ON sellers (erp_api_key_hash)
  WHERE erp_api_key_hash IS NOT NULL;

COMMIT;
