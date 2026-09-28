-- 20260515_0013: 2FA hardening
-- 1. totp_secret column now stores AES-256-GCM ciphertext prefixed with "v1:".
--    Legacy plaintext base32 values remain readable (decryptSecret transparent
--    fallback). For full rotation, users must regenerate 2FA from
--    /account/security (init → enable). No destructive backfill performed:
--    invalidating live 2FA without warning would lock out users.
--
-- 2. totp_backup_codes is already bcrypt-hashed in production (per
--    hashBackupCodes()). New regenerations use cost=12. Existing cost=10
--    hashes remain valid; verify continues to work via bcrypt.compare.
--
-- 3. To force rotation for a specific user (e.g. compromise), run:
--      UPDATE users SET totp_secret = NULL, totp_enabled_at = NULL,
--                       totp_backup_codes = NULL WHERE id = '<uuid>';
--    and notify them to re-enroll.

INSERT INTO schema_migrations (version, applied_at)
  VALUES ('20260515_0013', now())
  ON CONFLICT DO NOTHING;
