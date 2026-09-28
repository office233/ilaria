# Domain split and launch readiness — Azure audit, 2026-09-27

Base: `/opt/swypik/builds/mobile-auth-20260927-175259`, isolated Azure work directory `/opt/swypik/work/domains-launch-20260927`. No DNS, live environment, database, tunnel or process was changed by this audit. Source inspection is not proof of successful end-to-end user flows.

## Current findings and implemented preparation

- The live environment explicitly sets `NEXT_PUBLIC_APP_URL=https://swypik.com`. None of SITE_URL, NEXT_PUBLIC_SITE_URL, NEXT_PUBLIC_API_URL, OAUTH_REDIRECT_BASE, ALLOWED_ORIGINS_EXTRA is set. Those specific URL keys only were inspected; secret values were not collected.
- APP_URL is still the existing application base and its defaults/precedence are unchanged. New SITE_URL and API_URL exports make the distinction available to consumers; both default to APP_URL. They do not change callers automatically and do not change routing.
- The current API subdomain must not be assumed to serve all Next.js endpoints. A common gateway route map must preserve Next `/api/*` and Go routes; never expose server internal authorization secrets in a mobile or browser client.
- Middleware previously granted CSRF trust to SITE_URL implicitly. It now trusts only the application origin, the request's own origin and explicit extra origins. A distinct presentation site does not automatically gain authenticated API access. Current live domain and www behavior are preserved. Explicit non-default ports are preserved on the www alias. Loopback trust is development-only. HTTPS exact origins reject credentials, path/query/fragment and wildcard values.
- SITE_URL/API_URL reject invalid configured origins without logging their contents. NEXT_PUBLIC variables require a rebuild; server-only environment changes cannot update a shipped client bundle. The build configuration in infra/hetzner/docker-compose.prod.yml does not pass NEXT_PUBLIC_APP_URL, NEXT_PUBLIC_SITE_URL or NEXT_PUBLIC_API_URL as build arguments. Wiring these variables through the actual Docker build and verifying the browser bundle is a cutover blocker; runtime-only changes can produce different client and server URLs. Build configuration was not changed in this patch.
- CSP remains unchanged in this patch. General policy is in next.config.mjs; strict seller/admin/creator/courier CSP is in middleware.ts. Both allow the current API host; neither explicitly names app.swypik.com. Same-origin calls are already covered by `'self'`. Add cross-origin entries only where actual calls require them, synchronize both policies, and test rather than widen to `https:`.

## Mandatory gates before changing domains

1. Prepare a parallel application hostname with TLS and proxy routing on the existing infrastructure. Preserve `swypik.com` behavior until its replacement is verified. Prevent unwanted indexing of the temporary duplicate.
2. Specify cookie policy before changing APP_URL: ordinary auth derives `Domain` from APP_URL; OAuth session/state cookies are host-only. Parent and host cookies with the same name can coexist and break logout or select an unintended session. Explicitly test login, logout, password reset, seller/admin sessions and deletion of previous cookie variants. No cookie/auth implementation was changed here.
3. Keep OAuth start and callback on the same origin because state cookies are host-only. Register and verify Google/Apple callback URLs. Test success, cancellation and missing/invalid state with real provider configuration. Do not redirect an in-progress callback blindly to another host.
4. Verify checkout success/cancel URLs, webhook signatures/routes, reset and verification emails, shared product/video links, localized URLs and relative redirects. Maintain a concrete redirect map with query preservation where appropriate.
5. Serve the public presentation site with actual features, support contact, privacy and terms, and a real launch registration flow. The only waitlist found in current routes is `/api/fly/waitlist` for travel; it is not a general mobile launch subscription. Do not reuse its data model silently or display fake success/store links. Design consent, deduplication, retention/deletion and confirmation delivery before enabling a general waitlist.
6. Common API browser access requires an explicit CORS and credential policy in addition to CSRF. This patch does not implement CORS or assert mobile parity for seller/admin endpoints. Native bearer sessions must stay separate from internal Go service credentials.
7. Validate the parallel setup, preserve the current release and URL configuration for rollback, then change traffic with post-cutover checks. Do not replace all APP_URL imports mechanically: each must be classified as application action, public marketing link, canonical URL or API destination.

## Launch blockers versus follow-up improvements

Blockers to validate: operational email delivery; real payment flow and refunds; populated/moderated catalog; end-to-end sessions across intended hosts; accurate legal/support content; real waitlist persistence and delivery; backup restoration and recovery ownership. Existing `/privacy` and `/terms` routes exist, but route existence does not establish legal completeness or relevance to the mobile launch.

Operational evidence still needed: last successful data and object backup, independent restoration test and retention, external uptime alert delivery, error reporting delivery, disk/memory/database alarms, scheduled-job heartbeat, recovery time objective and documented rollback execution. This audit inspected source, not live alert receivers or data-server backups, so these remain unverified here rather than presumed missing.

Follow-up improvements: consolidate duplicated CSP construction, add controlled hostname handling at the gateway, classify all hard-coded absolute links, add load tests based on realistic feed/video/checkout traffic, and size from measured latency, resource usage and bandwidth. A single web/data deployment is not demonstrated million-user capacity. Respect the approximately USD 500 budget for the entire Azure estate; this patch creates no resources.

## Validation performed

Azure Docker `node:20.19.0-alpine`, limited to 1 CPU and 2500 MB: `vitest run tests/unit/url-origins.test.ts tests/unit/app-url-origins.test.ts tests/unit/middleware-origin-trust.test.ts --maxWorkers=1` passed 30 tests in 3 files. The tests exercise parser rejection, unchanged defaults, independent URL configuration and actual middleware CSRF responses. No full typecheck/build or live domain migration was performed in this isolated audit; the release owner performs integrated validation.
