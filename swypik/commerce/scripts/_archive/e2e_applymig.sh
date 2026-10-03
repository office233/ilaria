#!/usr/bin/env bash
P="docker exec multi-erp-postgres psql -U multi -d multi_erp"
$P -c "DELETE FROM products WHERE denumire LIKE '%Produs Test E2E%'"
$P -c "DROP INDEX IF EXISTS products_cod_unique"
$P -c "CREATE UNIQUE INDEX IF NOT EXISTS products_cod_unique_tenant ON products (tenant_id, cod) WHERE cod IS NOT NULL AND cod != ''"
$P -c "SELECT indexname FROM pg_indexes WHERE tablename='products'"
