#!/usr/bin/env bash
docker exec swypik-prod-postgres-1 psql -U swypik -d swypik_prod -Atc "select string_agg(column_name, ', ') from information_schema.columns where table_name='rides'"
docker exec swypik-prod-postgres-1 psql -U swypik -d swypik_prod -Atc "select status, count(*) from rides group by 1 order by 2 desc"
docker exec swypik-prod-postgres-1 psql -U swypik -d swypik_prod -Atc "select count(*) from rides where status in ('requested','searching') and requested_at < now() - interval '15 minutes'"
