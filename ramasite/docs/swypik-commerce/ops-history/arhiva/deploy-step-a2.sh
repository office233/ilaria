#!/usr/bin/env bash
# Pasul A2: aplică migrările noi (idempotente) și le înregistrează în schema_migrations(version).
set -euo pipefail
cd /opt/swypik/app
PSQL=(docker exec -i swypik-prod-postgres-1 psql -v ON_ERROR_STOP=1 -U swypik -d swypik_prod)

for m in 20260921_0001_seller_erp_tables.sql 20260921_0002_mystery_drop_claims.sql 20260921_0003_movies.sql \
         20260921_0004_movies_visibility_guard.sql 20260921_0005_movies_watchlist.sql 20260922_0001_music.sql \
         20260923_0001_youtube_music_cache.sql \
         20260924_0001_messenger_whatsapp_calls.sql 20260924_0002_ai_news.sql \
         20260924_0003_gaming_module.sql 20260924_0004_crypto_transactions.sql; do
  [ -f "db/migrations/$m" ] || { echo "MISSING $m"; exit 1; }
  v="${m%.sql}"
  already=$("${PSQL[@]}" -tAc "select 1 from schema_migrations where version = '$v'")
  if [ "$already" = "1" ]; then echo "skip (applied): $v"; continue; fi
  echo "apply: $v"
  "${PSQL[@]}" < "db/migrations/$m" > /dev/null
  "${PSQL[@]}" -c "insert into schema_migrations (version) values ('$v') on conflict do nothing" > /dev/null
done

echo "== verify =="
"${PSQL[@]}" -tAc "select version from schema_migrations where version like '2026092%' order by 1"
"${PSQL[@]}" -tAc "select string_agg(table_name, ',' order by table_name) from information_schema.tables where table_name in ('call_sessions','call_participants','message_receipts','news_articles','gaming_games','gaming_scores','crypto_transactions')"
echo "STEP A2 OK"
