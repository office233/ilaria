# Social Marketplace Infrastructure

This folder contains local and Kubernetes-ready scaffolding for the social marketplace data plane:

- PostgreSQL for marketplace state and bootstrap migrations from `db/migrations`.
- Redis for streams, queues, counters, and local readiness checks.
- ClickHouse for feed, video, commerce, and moderation analytics.
- Prometheus, postgres-exporter, redis-exporter, and Grafana for local observability.
- S3-compatible object storage for media. Local development uses MinIO through `docker-compose.social.yml`; production should use Cloudflare R2 or another managed object store.
- OpenSearch remains available for search experiments through the Compose `search` profile, but it is not on the critical path.

## Local Development

Compose owns infrastructure only. Next.js, the Go API, and Python workers run on the host so local reload/debug tools stay simple.

```powershell
Copy-Item .env.social.example .env.social
docker compose --env-file .env.social -f docker-compose.social.yml up -d postgres redis minio minio-init
```

Start the full infra stack, including ClickHouse and observability:

```powershell
docker compose --env-file .env.social -f docker-compose.social.yml up -d
```

Load the same env into any host terminal before running Go, Next, or workers:

```powershell
. .\infra\local\Import-SocialEnv.ps1 .\.env.social
```

The complete startup path and env matrix live in [docs/LOCAL_DEVELOPMENT.md](../docs/LOCAL_DEVELOPMENT.md).

## Service Notes

PostgreSQL loads migrations from `db/migrations` only on first volume initialization. Recreate the local database volume to replay bootstrap migrations from scratch.

MinIO creates `SOCIAL_MEDIA_BUCKET` through the `minio-init` service. The Go API reads `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, and `S3_MEDIA_BUCKET`; the Python video worker reads `S3_ENDPOINT_URL`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `S3_BUCKET`.

Grafana starts on `GRAFANA_PORT` and is pre-provisioned with Prometheus and Postgres data sources. Next.js uses port 3000 in the local runbook, leaving port 3001 for Grafana.

To include OpenSearch locally:

```powershell
docker compose --env-file .env.social -f docker-compose.social.yml --profile search up -d opensearch
```

## Kubernetes

The manifests in `infra/kubernetes/social-stack.yaml` are intentionally portable YAML. They are suitable for local clusters and staging environments, but production should normally replace in-cluster PostgreSQL, Redis, ClickHouse, OpenSearch, and object storage with managed services.

```powershell
kubectl apply -f infra/kubernetes/social-stack.yaml
```

Before applying, replace the sample secret values and review storage class defaults for your cluster. For Cloudflare R2, keep only app environment variables that point to R2; do not deploy the MinIO workload in production.
