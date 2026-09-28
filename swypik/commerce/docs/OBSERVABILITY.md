# Observability

Swypik should treat observability as part of the platform contract: every user action that matters for feed quality, checkout, upload processing, or creator attribution needs a request ID, structured error, and traceable event.

## Current State

- Go API uses structured `slog` via `services/platform-api/internal/platform/logger`.
- Go API emits `X-Request-ID` for every request.
- Next API routes log server errors with route-specific prefixes.
- Redis streams and `event_outbox` provide an audit path for feed/event telemetry.
- Prometheus and Grafana config exist under `infra/observability` and `infra/grafana`.

## Sentry-Ready Plan

No Sentry SDK is required for local development. When a Sentry DSN is available, add capture at these boundaries:

- Next.js route handlers: capture thrown server errors with route, request ID, user/session ID when available, and safe metadata.
- Go API recovery middleware: capture panics with request path, method, request ID, and service name.
- Python video worker: capture processing failures with `job_id`, `video_id`, `asset_id`, and FFmpeg stderr summary.
- Python AI worker: capture task failures with `job_id`, task list, and deterministic fallback mode.

Never send secrets, raw payment payloads, full authorization headers, or complete uploaded media paths containing user-private data.

## Minimum Event Fields

Use these fields consistently in logs and Sentry breadcrumbs:

- `service`: `next-web`, `platform-api`, `video-worker`, `ai-worker`
- `request_id`
- `actor_id` or `session_id`
- `route` or `job_type`
- `video_id`, `product_id`, `checkout_id` when relevant
- `environment`
- `error_code`

## Release Checklist

1. Set `SENTRY_DSN` only in server-side environments.
2. Set `SENTRY_ENVIRONMENT` to `development`, `preview`, or `production`.
3. Add source map upload only after the deployment target is fixed.
4. Filter PII and payment fields before capture.
5. Alert on upload failure rate, checkout failure rate, webhook verification failures, and event ingestion errors.
