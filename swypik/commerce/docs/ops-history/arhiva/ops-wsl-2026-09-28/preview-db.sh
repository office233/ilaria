#!/usr/bin/env bash
# Copie a DB de productie + migrarile din repo, expusa pe 127.0.0.1:15433 (db swypik_dev) pentru test local.
# Oprire: docker rm -f swypik-preview-db
set -euo pipefail
PW="$1"; MIG_DIR=/mnt/e/Swypik/swypik/app/db/migrations
IMG=$(docker inspect -f '{{.Config.Image}}' swypik-prod-postgres-1)
docker rm -f swypik-preview-db >/dev/null 2>&1 || true
docker run -d --name swypik-preview-db -p 127.0.0.1:15433:5432 -e POSTGRES_USER=swypik -e POSTGRES_PASSWORD="$PW" -e POSTGRES_DB=swypik_dev "$IMG" >/dev/null
for i in $(seq 1 30); do docker exec swypik-preview-db pg_isready -U swypik >/dev/null 2>&1 && break; sleep 1; done; sleep 2
docker exec swypik-prod-postgres-1 pg_dump -U swypik swypik_prod | docker exec -i swypik-preview-db psql -q -U swypik -d swypik_dev >/dev/null 2>&1
P=(docker exec -i swypik-preview-db psql -v ON_ERROR_STOP=1 -U swypik -d swypik_dev)
applied=$("${P[@]}" -tAc "select version from schema_migrations" | sort -u)
for m in $(ls $MIG_DIR/*.sql | xargs -n1 basename | sed 's/\.sql$//' | sort | comm -23 - <(echo "$applied")); do
  "${P[@]}" < "$MIG_DIR/$m.sql" >/dev/null && "${P[@]}" -c "insert into schema_migrations (version) values ('$m')" >/dev/null
done
"${P[@]}" -tAc "select 'migrari: '||count(*) from schema_migrations"
