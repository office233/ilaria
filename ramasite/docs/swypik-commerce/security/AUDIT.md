# Swypik Security Audit

Date: 2026-05-10
Scope: current working tree in `D:\swypik`

## Threat Model

Swypik is moving from a Next.js storefront into a social video marketplace. The highest-value assets are customer payment flows, creator payout/commission data, product/order data, video uploads, event telemetry, admin/debug surfaces, and supplier credentials. The exposed trust boundaries are browser-to-Next API routes, Next-to-Go proxy routes, Go platform API, Redis streams, Postgres, object storage, Stripe webhooks, supplier APIs, and future Cloudflare R2/CDN delivery.

Primary attacker classes:
- Anonymous shoppers abusing checkout, import, upload, event ingestion, and feed APIs.
- Malicious creators uploading unsafe media or manipulating product attribution.
- Supplier/webhook spoofers attempting order or payment state manipulation.
- Credential thieves targeting env leaks and debug endpoints.
- High-volume clients attempting feed/events/upload denial of service.

## Findings

### High: Default Admin Secret

Evidence: [app/admin/page.tsx](D:/swypik/app/admin/page.tsx:127) falls back to a hardcoded `Swypik-admin-2024` value when `ADMIN_SECRET` is absent.

Impact: Any production or preview environment without `ADMIN_SECRET` set has a predictable admin credential. This can expose admin UI data and future mutation flows.

Remediation:
- Remove the fallback.
- Return `404` or `401` when `ADMIN_SECRET` is unset.
- Add a test that production without `ADMIN_SECRET` is inaccessible.

### High: Go API Allows Wildcard CORS By Default

Evidence: [config.go](D:/swypik/services/platform-api/internal/platform/config/config.go:54) defaults `CORS_ALLOWED_ORIGINS` to `*`, and [api.go](D:/swypik/services/platform-api/internal/platform/http/api.go:437) reflects wildcard access.

Impact: Browser clients from arbitrary origins can call public Go endpoints. This is especially risky as checkout, social actions, uploads, and event ingestion gain authentication.

Remediation:
- Keep wildcard only for explicit local development.
- Require configured origins in production.
- Add environment validation on startup for `ENVIRONMENT=production`.

### High: Upload Init Does Not Authenticate Creator Identity

Evidence: [service.go](D:/swypik/services/platform-api/internal/videos/service.go:64) accepts `creator_id`/`user_id` directly from the request body.

Impact: A client can impersonate another creator by sending their ID. This affects video ownership, product attribution, processing jobs, and later commission tracking.

Remediation:
- Derive creator/user ID from verified auth/session claims.
- Treat request body creator ID as optional intent only, or reject mismatches.
- Add auth middleware before enabling public upload endpoints.

### Medium: Event Ingestion Has No Abuse Controls

Evidence: [api.go](D:/swypik/services/platform-api/internal/platform/http/api.go:60) exposes `/v1/events/batch`; [service.go](D:/swypik/services/platform-api/internal/events/service.go:84) limits batch size to 100 but has no per-IP/user rate limit or auth.

Impact: Attackers can flood Postgres/Redis with telemetry, distort ranking signals, and increase infrastructure cost.

Remediation:
- Add per-IP/session rate limiting.
- Add event type allowlist and payload size controls per metadata field.
- Store raw telemetry in a low-cost queue/analytics path before expensive DB writes.

### Medium: Stripe Webhook Handler In Go Does Not Verify Signatures

Evidence: [checkout/service.go](D:/swypik/services/platform-api/internal/checkout/service.go:171) parses JSON payloads but does not validate `Stripe-Signature`. The Next route does verify using `STRIPE_WEBHOOK_SECRET`.

Impact: If `/v1/payments/webhooks/stripe` is exposed, forged webhook events can be recorded or later drive order state changes.

Remediation:
- Require `Stripe-Signature`.
- Verify with `STRIPE_WEBHOOK_SECRET` before parsing semantic event data.
- Keep the Next webhook as the only production endpoint until Go verification exists.

### Medium: Debug Env Endpoint Exists

Evidence: [app/api/debug-env/route.ts](D:/swypik/app/api/debug-env/route.ts:7) enumerates environment key names.

Impact: Even when values are masked, key enumeration helps attackers map providers and secret names.

Remediation:
- Disable in production and preview unless protected by an admin secret.
- Prefer local-only scripts for env diagnostics.

## Validated Positive Controls

- Stripe Next webhook validates signatures before handling events.
- Import route requires `IMPORT_SECRET` and lazy DB initialization.
- Shopify debug endpoints are deprecated/blocked.
- Go JSON decoder uses `DisallowUnknownFields`, reducing loose payload acceptance.
- Worker tests now run through explicit per-worker pytest configs.

## Remaining Security Work

1. Add auth middleware for Go and Next protected social/creator routes.
2. Add rate limiting to Go events, upload init/complete, checkout, and follow endpoints.
3. Add request body size limits for media metadata and comments beyond the global 1 MB JSON cap.
4. Verify R2 upload URLs are scoped to object key, method, content type, and short TTL.
5. Add production startup validation for required secrets: `ADMIN_SECRET`, `STRIPE_WEBHOOK_SECRET`, `DATABASE_URL`, `REDIS_URL`, storage credentials, and allowed origins.
