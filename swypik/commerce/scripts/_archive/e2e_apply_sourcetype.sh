#!/usr/bin/env bash
docker exec swypik-prod-postgres-1 psql -U swypik -d swypik_prod -c "ALTER TABLE marketplace_products DROP CONSTRAINT IF EXISTS marketplace_products_source_type_check"
docker exec swypik-prod-postgres-1 psql -U swypik -d swypik_prod -c "ALTER TABLE marketplace_products ADD CONSTRAINT marketplace_products_source_type_check CHECK (source_type = ANY (ARRAY['seller','aliexpress','affiliate','manual','other','meister_erp','multi_erp']))"
