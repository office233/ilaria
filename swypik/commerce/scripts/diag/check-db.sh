#!/usr/bin/env bash
# Diagnoza: unde e baza reala swypik_prod (151 tabele)?
set -uo pipefail

echo "== swypik-prod-postgres-1 / swypik_prod =="
docker exec swypik-prod-postgres-1 psql -U swypik -d swypik_prod -tAc \
  "select count(*) from information_schema.tables where table_schema='public'" 2>&1

echo "== meister-postgres: baze =="
docker exec meister-postgres psql -U postgres -tAc "select datname from pg_database" 2>&1

echo "== meister-postgres / swypik_prod (daca exista) =="
docker exec meister-postgres psql -U postgres -d swypik_prod -tAc \
  "select count(*) from information_schema.tables where table_schema='public'" 2>&1

echo "== ce DATABASE_URL foloseste app-ul swypik =="
docker exec swypik-prod-web-1 env 2>/dev/null | grep -E '^DATABASE_URL' | sed 's/:[^:@]*@/:***@/' \
  || for c in $(docker ps --format '{{.Names}}' | grep -i swypik); do
       echo "-- $c"; docker exec "$c" env 2>/dev/null | grep -E '^DATABASE_URL' | sed 's/:[^:@]*@/:***@/'
     done
