#!/usr/bin/env bash
S="docker exec swypik-prod-postgres-1 psql -U swypik -d swypik_prod"
$S -c "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='marketplace_products_source_type_check'"
