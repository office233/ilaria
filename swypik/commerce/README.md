# Swypik

A social video commerce platform where users discover and buy products through a vertical video feed, creators earn commissions, and ranking/AI workflows help convert user behavior into recommendations and sales.

This repository is positioned as a portfolio project for **full-stack product engineering**, **commerce infrastructure**, **event-driven systems**, and **AI-assisted product workflows**.

## What this project demonstrates

- **Full-stack product architecture**: Next.js frontend, Go backend, Python workers, PostgreSQL, Redis Streams, ClickHouse, and object storage.
- **Commerce workflow design**: product discovery, creator content, commissions, checkout, analytics, and ranking/event pipelines.
- **Backend/platform engineering**: modular API service, background workers, migrations, queues, object storage, and observability services.
- **AI-ready infrastructure**: Python worker layer for video processing and AI/ranking scaffolding.
- **Local production-like development**: Docker Compose stack for databases, streams, analytics, storage, search, Prometheus, and Grafana.

## Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 14, React, Tailwind CSS, PWA |
| Backend | Go modular monolith in `services/platform-api` |
| Workers | Python video processing and AI scaffolding |
| Database | PostgreSQL 16 |
| Streams | Redis Streams |
| Analytics | ClickHouse |
| Search | OpenSearch, optional profile |
| Storage | Cloudflare R2 / MinIO-compatible object storage |
| Payments | Stripe Checkout |
| Observability | Prometheus, Grafana, exporters |

## Architecture

```text
swypik/
├── services/
│   └── platform-api/          # Go backend API
├── workers/
│   └── video-worker/          # Python worker for video/AI processing flows
├── db/
│   └── migrations/            # PostgreSQL schema migrations
├── infra/
│   ├── clickhouse/            # Analytics database configuration
│   ├── grafana/               # Dashboard provisioning
│   ├── local/                 # Local environment helpers
│   └── observability/         # Prometheus configuration
├── docs/                      # Architecture and local development docs
├── docker-compose.social.yml  # Local platform dependencies
└── package.json               # Frontend/workspace scripts
```

## Local development

See [`docs/LOCAL_DEVELOPMENT.md`](docs/LOCAL_DEVELOPMENT.md) for the full runbook.

Quick start:

```powershell
Copy-Item .env.social.example .env.social
docker compose --env-file .env.social -f docker-compose.social.yml up -d postgres redis minio minio-init
```

Load the shared environment in separate PowerShell terminals:

```powershell
. .\infra\local\Import-SocialEnv.ps1 .\.env.social
```

Run the API:

```powershell
cd services\platform-api
go run .\cmd\api
```

Run the web app:

```powershell
npm run dev -- -p 3000
```

Run the video worker:

```powershell
cd workers\video-worker
python -m video_worker.main --once
```

## Local infrastructure

The Docker Compose stack includes:

- PostgreSQL for transactional data;
- Redis Streams for event/work queues;
- ClickHouse for analytics;
- OpenSearch for optional search workflows;
- MinIO for local S3-compatible media storage;
- Prometheus and Grafana for observability;
- database and Redis exporters for metrics.

## Why this is relevant to product engineering roles

Swypik shows the ability to build beyond a prototype UI:

- product flows across frontend, backend, workers, storage, analytics, and payments;
- event-driven architecture for feed/ranking/commerce behavior;
- local infra close to production patterns;
- operational thinking around metrics and observability;
- AI-ready worker architecture for ranking, video analysis, and recommendation experiments.

This project maps well to roles involving AI product engineering, platform engineering, commerce systems, backend infrastructure, and applied AI product development.

## Roadmap

- Add demo video/GIF of the user and creator flows.
- Add architecture diagram.
- Add CI for backend, frontend, and worker tests.
- Add seed data and demo scenario.
- Add benchmark/report for feed API latency and worker throughput.
- Add clear AI/ranking experiment documentation.

## License

Proprietary - (c) 2026 Swypik
