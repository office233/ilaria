# Azure launch hardening — scope and remaining blockers

All source changes, tests and builds for this batch are performed on the Azure web VM. The local machine is SSH transport only. Runtime deployment is owned by the coordinator, not individual agents.

## Scope
- Authentication: prevent password/OTP bypass of enabled TOTP, restrict OAuth email linking, correct mail delivery reporting, single-use challenges and password resets.
- Commerce: delayed-payment settlement gate, asynchronous success dispatch, bounded Stripe webhook body, currency-sensitive cart fingerprint.
- Domain preparation: separate configurable public/application/API origins without changing live DNS or runtime domains; no implicit CSRF trust for a separate marketing site.

## Launch blockers, not resolved by this batch
- Email provider is not configured for actual delivery; Google/Apple OAuth credentials absent in audited runtime.
- Stripe keys are placeholders. No real charges or refunds have been tested.
- Commerce settlement/stock/event claims require an atomic transaction and durable retryable outbox before real commerce activation. The current isolated fixes do not solve crash recovery.
- Public feed and catalog return zero items. No fabricated or third-party catalog is imported.
- Current Azure source has no app/api/ilaria route or lib/ai/ilaria.ts. The earlier pilot contract must be located and integrated separately; Ilaria availability in Azure is not established.
- Social identity resolves cookies, not mobile Bearer sessions. Shared social authentication requires a separate compatibility change.
- Feed visibility checks account status but not future suspended_until. Review moderation policy and add real SQL integration coverage before modifying this rule.
- No evidence yet of load capacity for millions or a sustainable measured total Azure cost under USD500/month.
- app/API domain cutover and public presentation/waitlist are not performed by this release.
- Studio remains excluded from the mobile prototype; no claim is made that every existing web creation route has been disabled.

No live user data, DNS, cloud resources, paid services, or GPU resources are changed by agent patches. Release verification results are recorded separately after execution.
