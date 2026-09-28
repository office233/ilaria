# Auth and email hardening — Azure, 27 September 2026

Work performed only on Azure web1, copied from mobile-auth-20260927-175259 into /opt/swypik/work/auth-email-20260927. No live environment, DNS, production database, accounts, email deliveries, or running application containers were modified.

## Confirmed fixes prepared

- Password-only bearer token issuance now fails closed for accounts with TOTP enabled (403 two_factor_required). A complete mobile second-factor challenge remains future work.
- Email OTP login also refuses a full session for TOTP-enabled accounts; their existing password + verify_2fa flow remains available.
- Web second-factor verification validates challenge/code format, limits IP and challenge attempts, rechecks account restrictions, and consumes each challenge once via Redis DEL.
- Backup codes are consumed using conditional compare-and-swap on the previous code list. Concurrent challenges cannot consume the same snapshot twice.
- Email OTP consumption is conditional and checks RETURNING before creating a session.
- Password reset uses the existing withTransaction helper (one pooled connection). A conditional UPDATE consumes the reset token, updates the password and revokes user_sessions in one transaction. Concurrent reset and rollback verified against disposable PostgreSQL.
- OAuth may link by email only when the provider verifies that address. Unverified provider email is omitted for new accounts; existing linked subjects still sign in.
- Token issuance and refresh responses explicitly use Cache-Control: no-store.
- Token revocation validates the canonical 64-character lowercase hex token format.
- Missing email transports return false. OTP delivery now propagates actual transport rejection instead of always returning true. Generic transactional mail no longer reports delivery when no transport is configured.

## Verification

Azure Docker node:20.19.0-alpine, at most one CPU, 2500 MB memory:
- Six focused Vitest files: initially 33 passed; final added backup-code regression makes 34 distinct tests. Updated auth-2fa-guard suite rerun: 7/7 passed.
- TypeScript noEmit passed before the final backup-code CAS and integration-fixture additions; root performs integrated validation after handoff.
- Disposable postgres:16-alpine fixture, no public ports or production credentials: 8 concurrent resets yield exactly one success; replay and expired tokens fail; trigger-induced session revocation failure rolls back token consumption and password; retry succeeds after removing failure; 8 concurrent backup-code consumptions yield exactly one success.
- Fixture container removed after completion. Fixture code: tests/integration/auth-password-reset.ts. No real email sent.

## Configuration presence only

- RESEND_API_KEY is a placeholder.
- SMTP_HOST/SMTP_USER/SMTP_PASS are absent.
- EMAIL_FROM exists.
- Google client ID/secret and all Apple OAuth credentials are absent.
Thus real email delivery and provider end-to-end OAuth are blocked by configuration, not established as working.

## Remaining work, explicitly not a complete security audit

- Provide a mobile second-factor challenge before enabling bearer login for TOTP accounts.
- Audit OAuth second-factor policy, existing sessions issued before these fixes, session invalidation for separate seller/admin sessions on password reset, and password/signup recovery end-to-end.
- Signup and forgot-password retain existing response contracts; they do not guarantee delivery. Mail configuration and delivery monitoring are still required.
- OAuth session cookies are host-only while password/OTP cookies use APP_URL hostname Domain. Domain migration needs a consistent explicit cookie policy and legacy cookie cleanup.
- Social identity helpers are still cookie-based; bearer social actions require a separate compatibility change.
- Existing broad audit/full suite and production canary checks are root integration responsibilities.
