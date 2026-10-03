-- Curățarea finală a tabelelor AliExpress din DB.
-- ⚠️ RULARE MANUALĂ pe producție, DUPĂ backup:
--   docker exec swypik-prod-postgres-1 pg_dump -U swypik -d swypik_prod -t 'ae_*' > /root/backup_ae_tables.sql
--   docker exec -i swypik-prod-postgres-1 psql -U swypik -d swypik_prod < scripts/db/drop-ae-tables.sql
--
-- Comenzile istorice din commerce_orders NU se ating (obligație contabilă);
-- statusurile pending_dropship rămân doar ca valori istorice pe rânduri vechi.

DROP TABLE IF EXISTS ae_import_jobs CASCADE;
DROP TABLE IF EXISTS ae_variants CASCADE;
DROP TABLE IF EXISTS ae_category_full_chain CASCADE;
DROP TABLE IF EXISTS ae_categories CASCADE;
DROP TABLE IF EXISTS ae_oauth_tokens CASCADE;
DROP TABLE IF EXISTS ae_products CASCADE;
