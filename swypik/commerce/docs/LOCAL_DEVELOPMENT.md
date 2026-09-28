# Local Development

This runbook starts the local social stack end to end with Docker-hosted infrastructure and host-run Next.js, Go API, and Python workers.

## Ports

| Service | Local URL |
| --- | --- |
| Next.js | http://localhost:3000 |
| Go platform API | http://localhost:8080 |
| PostgreSQL | localhost:5432 |
| Redis | localhost:6379 |
| MinIO API | http://localhost:9000 |
| MinIO Console | http://localhost:9001 |
| Grafana | http://localhost:3001 |
| Prometheus | http://localhost:9090 |
| ClickHouse HTTP | http://localhost:8123 |

## One-Time Setup

```powershell
Copy-Item .env.social.example .env.social
```

Review `.env.social` before first use. It is the shared local env file for Docker Compose plus every host-run process. If you already have `.env.local`, make sure it does not point Next to old ports; dot-sourcing `.env.social` in a terminal sets process env for commands launched from that terminal.

## Start Infrastructure

Core runtime dependencies only:

```powershell
docker compose --env-file .env.social -f docker-compose.social.yml up -d postgres redis minio minio-init
docker compose --env-file .env.social -f docker-compose.social.yml ps
```

Full local infrastructure with ClickHouse, exporters, Prometheus, and Grafana:

```powershell
docker compose --env-file .env.social -f docker-compose.social.yml up -d
```

OpenSearch is optional and off the critical path:

```powershell
docker compose --env-file .env.social -f docker-compose.social.yml --profile search up -d opensearch
```

## Load Env In Each Terminal

Use this before starting Go, Next, or a worker:

```powershell
. .\infra\local\Import-SocialEnv.ps1 .\.env.social
```

The leading dot is required; it loads variables into the current PowerShell session.

## Start The Go API

```powershell
. .\infra\local\Import-SocialEnv.ps1 .\.env.social
cd services\platform-api
go run .\cmd\api
```

Check it from another terminal:

```powershell
Invoke-RestMethod http://localhost:8080/healthz
Invoke-RestMethod http://localhost:8080/readyz
```

`/readyz` should show `postgres: ok` and `redis: ok` when `DATABASE_URL` and `REDIS_URL` are loaded.

## Start Next.js

```powershell
. .\infra\local\Import-SocialEnv.ps1 .\.env.social
npm run dev -- -p 3000
```

Check the Go proxy path:

```powershell
Invoke-RestMethod "http://localhost:3000/api/v1/feed?limit=1"
```

If this returns the Next fallback saying the Go social API is not configured, `SOCIAL_API_URL`, `GO_API_URL`, or `NEXT_PUBLIC_SOCIAL_API_URL` was not loaded.

## Start Workers

Video worker:

```powershell
cd workers\video-worker
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
. ..\..\infra\local\Import-SocialEnv.ps1 ..\..\.env.social
python -m video_worker.main --once
```

`--once` exits after one job or after the Redis stream poll times out. Remove `--once` to keep polling `VIDEO_QUEUE_NAME`.

AI worker:

```powershell
cd workers\ai-worker
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m pytest
```

The AI worker package currently has parsing and processor scaffolding but no env-backed daemon entrypoint.

## Env Names Used By Go

Defined in `services/platform-api/internal/platform/config/config.go`:

| Variable | Purpose |
| --- | --- |
| `HOST` | HTTP bind host |
| `PORT` | HTTP port |
| `ENVIRONMENT` | Runtime environment label |
| `LOG_LEVEL` | Go logger level |
| `CORS_ALLOWED_ORIGINS` | Comma-separated allowed origins |
| `DATABASE_URL` | PostgreSQL URL |
| `REDIS_URL` | Redis URL |
| `PUBLIC_UPLOAD_BASE_URL` | Base URL returned by upload init |
| `UPLOAD_TTL_MINUTES` | Upload URL TTL |
| `S3_ENDPOINT` | Go S3/R2 endpoint |
| `S3_REGION` | Go S3/R2 region |
| `S3_ACCESS_KEY_ID` | Go S3/R2 access key |
| `S3_SECRET_ACCESS_KEY` | Go S3/R2 secret key |
| `S3_MEDIA_BUCKET` | Go media bucket |
| `S3_FORCE_PATH_STYLE` | Go S3 path-style flag |
| `STRIPE_SECRET_KEY` | Stripe API key |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook secret |
| `CLICKHOUSE_URL` | ClickHouse HTTP URL |

## Env Names Used By Python Workers

The video worker reads these names in `workers/video-worker/video_worker/config.py`:

| Variable | Purpose |
| --- | --- |
| `REDIS_URL`, `VIDEO_REDIS_URL` | Redis queue URL |
| `DATABASE_URL`, `POSTGRES_URL` | Optional Postgres URL for status updates |
| `VIDEO_QUEUE_BACKEND` | `stream` or `list` |
| `VIDEO_QUEUE_NAME`, `VIDEO_QUEUE` | Redis stream/list key |
| `VIDEO_CONSUMER_GROUP` | Redis Streams consumer group |
| `VIDEO_CONSUMER_NAME` | Redis Streams consumer name |
| `S3_BUCKET`, `R2_BUCKET` | Input/default bucket |
| `VIDEO_OUTPUT_BUCKET`, `S3_OUTPUT_BUCKET`, `R2_OUTPUT_BUCKET` | Output bucket |
| `S3_ENDPOINT_URL`, `R2_ENDPOINT_URL` | Python S3/R2 endpoint |
| `AWS_REGION`, `S3_REGION`, `R2_REGION` | Python S3/R2 region |
| `S3_PUBLIC_BASE_URL`, `R2_PUBLIC_BASE_URL` | Public media URL base |
| `VIDEO_JOBS_TABLE` | Postgres jobs table |
| `VIDEO_ASSETS_TABLE` | Postgres assets table |
| `VIDEO_VARIANTS` | HLS variants as `name:widthxheight:bitrate` |
| `VIDEO_POLL_TIMEOUT_SECONDS` | Queue poll timeout |
| `VIDEO_WORK_DIR` | Worker scratch directory root |
| `AWS_ACCESS_KEY_ID`, `R2_ACCESS_KEY_ID` | Python S3/R2 access key |
| `AWS_SECRET_ACCESS_KEY`, `R2_SECRET_ACCESS_KEY` | Python S3/R2 secret key |
| `VIDEO_FAILED_STREAM` | Optional failed-job stream |
| `VIDEO_ACK_FAILED_JOBS` | Acknowledge failed stream jobs |

The AI worker currently reads no environment variables.

## Env Names Used By Next.js

Direct `process.env` references under `app/`, `lib/`, and `next.config.mjs`:

| Variable | Purpose |
| --- | --- |
| `NODE_ENV` | Next/PWA behavior and production checks |
| `VERCEL_ENV` | Debug env reporting |
| `DATABASE_URL` | Next server-side Postgres queries/imports |
| `SOCIAL_API_URL`, `GO_API_URL`, `NEXT_PUBLIC_SOCIAL_API_URL` | Go API proxy base URL |
| `NEXT_PUBLIC_APP_URL` | Stripe success/cancel URL base |
| `STRIPE_SECRET_KEY` | Stripe Checkout |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook verification |
| `ADMIN_SECRET` | Machine secret for admin APIs (`Authorization: Bearer`, scripts/cron); humans sign in with their own admin account |
| `ADMIN_BREAK_GLASS_ENABLED` | `1` enables emergency `/admin` login with `ADMIN_SECRET` + an admin email (off by default) |
| `ADMIN_SESSION_TTL_HOURS` | Admin session lifetime in hours (default 12) |
| `ADMIN_DEBUG_SECRET` | Production debug route guard |
| `IMPORT_SECRET` | Import API guard |
| `AZURE_OPENAI_ENDPOINT` / `AZURE_OPENAI_API_KEY` | Azure AI Foundry (singurul furnizor AI) |
| `AZURE_OPENAI_CHAT_DEPLOYMENT` / `AZURE_OPENAI_WHISPER_DEPLOYMENT` | deployment-uri chat + Whisper |
| `AZURE_CONTENT_SAFETY_ENDPOINT` / `AZURE_CONTENT_SAFETY_KEY` | moderare text + imagine |
| `SHOPIFY_STORE` | Shopify store host |
| `SHOPIFY_CLIENT_ID` | Shopify OAuth/client ID |
| `SHOPIFY_CLIENT_SECRET` | Shopify OAuth secret |
| `SHOPIFY_API_VERSION` | Shopify Admin API version |
| `SHOPIFY_STOREFRONT_API_VERSION` | Shopify Storefront API version |
| `SHOPIFY_STOREFRONT_ACCESS_TOKEN`, `NEXT_PUBLIC_SHOPIFY_STOREFRONT_ACCESS_TOKEN` | Storefront access token |
| `CJ_API_KEY` | CJ supplier integration |
| `OTAPI_KEY` | OTAPI supplier integration |
| `RAPIDAPI_HOST`, `RAPIDAPI_KEY` | AliExpress supplier integration |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Next rate limiting |

## Stop Or Reset

Stop containers without deleting data:

```powershell
docker compose --env-file .env.social -f docker-compose.social.yml down
```

Replay Postgres bootstrap migrations from scratch:

```powershell
docker compose --env-file .env.social -f docker-compose.social.yml down -v
docker compose --env-file .env.social -f docker-compose.social.yml up -d postgres redis minio minio-init
```
