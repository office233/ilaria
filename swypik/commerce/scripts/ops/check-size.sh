#!/usr/bin/env bash
set -euo pipefail
docker exec swypik-prod-postgres-1 psql -U swypik -d swypik_prod -tAc \
  "select pg_size_pretty(pg_database_size(current_database()))"
docker exec swypik-prod-postgres-1 psql -U swypik -d swypik_prod -tAc \
  "select 'products: '||count(*) from marketplace_products"
docker exec swypik-prod-postgres-1 psql -U swypik -d swypik_prod -tAc \
  "select 'sellers: '||count(*) from sellers"
