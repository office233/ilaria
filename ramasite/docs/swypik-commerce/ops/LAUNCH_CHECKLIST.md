# Swypik Hetzner Launch Checklist

This checklist covers the last-mile production checks for the Hetzner launch. It assumes the app is deployed under `/opt/swypik/app` and Caddy serves `https://swypik.com` and `https://api.swypik.com`.

## 1. Deploy And Smoke Test

- Run the deploy script from the VPS: `cd /opt/swypik/app && ./infra/hetzner/deploy.sh`.
- Run the smoke test after deploy:

```bash
WEB_BASE_URL=https://swypik.com \
API_BASE_URL=https://api.swypik.com \
./infra/hetzner/smoke-test.sh
```

- If product discovery fails, rerun with a known active product id:

```bash
SMOKE_PRODUCT_ID=<active-product-id> ./infra/hetzner/smoke-test.sh
```

The smoke test covers homepage, product page, explore, account, creator upload, seller, admin, checkout negative paths, Stripe webhook bad-signature handling, and Go API health/readiness without creating real payments.

## 2. VPS Hardening And Backups

- Fix permissive files after deploy:

```bash
cd /opt/swypik/app
sudo ./infra/hetzner/harden-permissions.sh
```

- Install the daily PostgreSQL backup cron:

```bash
cd /opt/swypik/app
sudo INSTALL_BACKUP_CRON=true ./infra/hetzner/harden-permissions.sh
```

- Confirm cron is present: `sudo crontab -l | grep backup-postgres.sh`.
- Confirm backup output after the next run: `ls -lh /opt/swypik/backups`.
- Validate the latest gzip: `gzip -t /opt/swypik/backups/<latest>.sql.gz`.
- Keep `/opt/swypik`, `/opt/swypik/app`, `/opt/swypik/backups`, and `/opt/swypik/logs` at `750`; keep `.env.production` at `640`.

## 3. Sentry Setup

Set these server-side variables in `infra/hetzner/.env.production` when Sentry is ready:

- `SENTRY_DSN=<server-side DSN>`
- `SENTRY_ENVIRONMENT=production`
- `SENTRY_RELEASE=<git sha or release tag>`

Alert rules to create in Sentry:

- New issue or regression in `next-web`, `platform-api`, `video-worker`, or `ai-worker`.
- Error count above threshold for checkout, creator upload, video processing, webhook handling, or feed APIs.
- Transaction or error spike for `/api/checkout`, `/api/creator/upload-session`, `/api/webhooks/stripe`, `/api/explore/feed`, `/v1/videos/uploads/init`, and `/v1/events/batch`.

Do not send secrets, authorization headers, raw Stripe payloads, full upload paths, or customer payment data.

## 4. Uptime Monitors

Create Cloudflare uptime monitor checks for:

- `https://swypik.com/api/health` expecting HTTP `200` and a JSON body containing `"status"`.
- `https://api.swypik.com/healthz` expecting HTTP `200`.
- `https://api.swypik.com/readyz` expecting HTTP `200`.

Use at least two regions if available. Alert to the launch owner and the ops channel on two consecutive failures. Keep `/readyz` as the dependency-aware monitor and `/healthz` as the process liveness monitor.

## 5. Stripe Webhook Alert Path

- Stripe webhook endpoint: `https://swypik.com/api/webhooks/stripe`.
- Subscribe to at least `checkout.session.completed`, `payment_intent.succeeded`, and `payment_intent.payment_failed`.
- Confirm an unsigned webhook request returns HTTP `400`.
- Alert on Stripe webhook delivery failures in the Stripe Dashboard.
- Alert on app-side failures by watching logs for `[Stripe Webhook] Signature verification failed` and `[Stripe Webhook] Handler failed`.
- Query audit trail for app-side failures:

```sql
SELECT created_at, event, error, payload
FROM checkout_audit_log
WHERE event = 'webhook_fail'
ORDER BY created_at DESC
LIMIT 50;
```

## 6. Rate Limit, File Validation, Audit Log Checklist

Use this as the launch checklist for rate limit, file validation, and audit log coverage.

- Rate limit: confirm checkout, chat, products, search suggest, social actions, event ingestion, and upload-init endpoints have explicit limits.
- Rate limit: if using Upstash REST for Next.js, set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`; only set `RATE_LIMIT_REDIS_REQUIRED=true` after those are present.
- Rate limit: keep the Go API protected with `PLATFORM_API_SECRET`; public POSTs to `/v1/videos/uploads/init` and `/v1/events/batch` should return `401`.
- File validation: image upload stays authenticated and enforces type and 5 MB size.
- File validation: creator video upload should only accept expected video MIME types/extensions, enforce max size, and use short-lived presigned URLs.
- File validation: R2/CORS should only allow required methods and origins.
- Audit log: checkout success, checkout failure, rate-limit blocks, product-not-found, and `webhook_fail` events should write to `checkout_audit_log`.
- Audit log: add explicit audit events before launch for admin product mutations, seller product mutations, payouts, and refunds.

## 7. Final Go/No-Go

- `./infra/hetzner/smoke-test.sh` passes.
- `docker compose -f infra/hetzner/docker-compose.prod.yml --env-file infra/hetzner/.env.production ps` shows expected services healthy/running.
- Backup cron is installed and at least one backup file passes `gzip -t`.
- Cloudflare DNS and TLS are green for `swypik.com` and `api.swypik.com`.
- Stripe webhook delivery succeeds for signed test events.
- No files under `/opt/swypik` are world-writable.
