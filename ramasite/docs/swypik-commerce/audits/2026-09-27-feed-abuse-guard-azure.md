# Feed request abuse guard — Azure, 27 September 2026

Base release: launch-hardening-20260927-181020. Work: /opt/swypik/work/feed-guard-20260927. SSH client only on PC; edits and tests performed in Azure. No changes to environment, production data, or deployment.

## Fixed

The feed route previously used client-controlled query session_id as the rate limiter key and resolved authenticated identity (DB lookup) before enforcing limits. Changing only session_id produced fresh independent counters, even after the anonymous-session mint limit was exhausted.

The route now enforces:

1. exploreFeedIp namespace: 1200 requests / 60 seconds per trusted ingress client IP, before social-auth lookup or feed queries.
2. Existing exploreFeed namespace: 120 requests / 60 seconds per verified user u:<id>, cryptographically verified cookie s:<sid>, or fallback ip:<ip> when no identity is verified. Query session_id is never used in these keys. Session minting occurs only after both checks.
3. 429 responses are private/no-store and include Retry-After: 60.

The aggregate IP allowance is deliberately ten times the per-viewer allowance to accommodate shared NATs. Established users and signed-cookie viewers retain separate identity budgets. Cookie-less visitors behind one NAT share the 120/min fallback; traffic and 429 telemetry are needed to calibrate limits. This is a bounded initial policy, not a measured million-user capacity claim.

Namespace compatibility: existing exploreFeed prefix retained, typed u:/s:/ip: identifiers added to avoid namespace collisions; counters from the old untyped identifiers do not carry across the first 60-second window after deployment. exploreFeedIp is a new independent coarse bucket. Existing distributed rate-limit helper and fail-closed Redis behavior are reused unchanged. Ingress must continue overwriting the trusted client-IP header used by getClientIP.

Session minting is already IP-limited by the existing helper. This patch stops query-only/forged-cookie bypass; it does not claim to prevent distributed bots or possession of multiple valid identities.

## Tests

22 tests passed across:
- tests/unit/feed-rate-limit-route.test.ts (new, 7)
- tests/unit/feed-route.test.ts (existing contract, 7)
- tests/unit/feed-events-batch-route.test.ts (existing ingest, 8)

New tests use a stateful rate-limiter double and REAL feed-session HMAC signing/verification. They check 121 requests with rotating query IDs are blocked at 120; the same for a stable valid cookie; forged cookies use IP fallback; blocked IP never reaches auth, cookie minting, or feed; user and anonymous viewers on shared NAT remain independent; authenticated user cannot escape via cookie/query rotation. These are in-process unit requests, not load against public endpoints. Existing tests deliberately mock unavailable Redis, producing expected fallback warnings.

Runtime: Azure Docker node:22-alpine, network none, 1 CPU, 768 MiB, single Vitest worker, 1.96 seconds. Root owns full typecheck/build/integration and deployment.
