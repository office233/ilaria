#!/usr/bin/env bash
docker exec swypik-prod-postgres-1 psql -U swypik -d swypik_prod -c "SELECT id,status,erp_connected,(erp_api_key IS NOT NULL) AS has_key FROM sellers WHERE id='2de67593-ab06-4f1a-b025-66330ccf26b3'"
docker exec multi-erp-postgres psql -U multi -d multi_erp -c "SELECT column_name,data_type FROM information_schema.columns WHERE table_name='users' AND column_name='active'"
docker exec multi-erp-postgres psql -U multi -d multi_erp -c "SELECT id,slug,company_name FROM tenants ORDER BY id DESC LIMIT 5"
