set -euo pipefail
cd /opt/swypik/app
sudo -u dev git pull -q --ff-only origin main
P=(docker exec -i swypik-prod-postgres-1 psql -v ON_ERROR_STOP=1 -U swypik -d swypik_prod)
"${P[@]}" < db/migrations/20260925_0011_news_seed_cleanup.sql
"${P[@]}" -c "insert into schema_migrations (version) values ('20260925_0011_news_seed_cleanup') on conflict do nothing" >/dev/null
"${P[@]}" -tAc "select status, count(*) from news_articles group by 1"
