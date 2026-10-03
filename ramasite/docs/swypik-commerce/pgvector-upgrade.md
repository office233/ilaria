# pgvector upgrade guide

Current image: `postgres:16-alpine` — **NU conține** binarul `vector`.
Eroare la `CREATE EXTENSION vector`:
```
ERROR: extension "vector" is not available
DETAIL: Could not open extension control file
HINT: The extension must first be installed on the system where PostgreSQL is running.
```

## Pași upgrade la `pgvector/pgvector:pg16`

```bash
# 1. Backup complet
cd /opt/swypik/app
docker exec swypik-prod-postgres-1 pg_dump -U swypik -d swypik -Fc \
  -f /tmp/swypik-pre-pgvector.dump
docker cp swypik-prod-postgres-1:/tmp/swypik-pre-pgvector.dump \
  /opt/backups/swypik-pre-pgvector-$(date +%F).dump

# 2. Down doar postgres + dependents
docker compose -f infra/hetzner/docker-compose.prod.yml stop \
  web-next video-worker cron-worker
docker compose -f infra/hetzner/docker-compose.prod.yml stop postgres

# 3. Update infra/hetzner/docker-compose.prod.yml
#    postgres.image: pgvector/pgvector:pg16

# 4. Pull + up postgres
docker compose -f infra/hetzner/docker-compose.prod.yml pull postgres
docker compose -f infra/hetzner/docker-compose.prod.yml up -d postgres

# Volume swypik_postgres_data e compatibil (același major 16).
# Așteaptă ~10s ca postgres să fie ready.

# 5. Enable extension (datele rămân intacte)
docker exec swypik-prod-postgres-1 psql -U swypik -d swypik \
  -c 'CREATE EXTENSION IF NOT EXISTS vector;'

# 6. Aplică migrația 0024
docker exec -i swypik-prod-postgres-1 psql -U swypik -d swypik \
  < db/migrations/20260515_0024_ai_embeddings.sql

# 7. Repornește restul
docker compose -f infra/hetzner/docker-compose.prod.yml up -d \
  web-next video-worker cron-worker

# 8. Verifică
docker exec swypik-prod-postgres-1 psql -U swypik -d swypik \
  -c "SELECT extname, extversion FROM pg_extension WHERE extname='vector';"
```

## Rollback
Dacă ceva pică:
```bash
# revert image la postgres:16-alpine în compose, up -d postgres
# datele rămân — doar nu vei putea face CREATE EXTENSION vector
docker exec -i swypik-prod-postgres-1 pg_restore -U swypik -d swypik -c \
  < /opt/backups/swypik-pre-pgvector-YYYY-MM-DD.dump
```

## Notă
- Volumul `swypik_postgres_data` e legat de cluster-ul fizic — `pgvector/pgvector:pg16` folosește același PG 16, deci nu e nevoie de dump/restore complet. Backup-ul e doar safety net.
- După upgrade, `app/api/cron/embed-batch` va începe să populeze embeddings la fiecare 15 minute (50 produse + 50 video per tick).
