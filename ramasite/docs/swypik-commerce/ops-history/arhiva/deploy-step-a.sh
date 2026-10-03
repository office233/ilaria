#!/usr/bin/env bash
# Pasul A al deploy-ului local (WSL distro `swypik`): backup, pull, flag-uri, migrări.
# Rulat ca root: bash /mnt/e/Swypik/deploy-step-a.sh
set -euo pipefail
cd /opt/swypik/app

echo "== 1. backup =="
f="/opt/swypik/backups/pre-movies-music-$(date +%Y%m%d-%H%M).sql.gz"
docker exec swypik-prod-postgres-1 pg_dump -U swypik swypik_prod | gzip > "$f"
ls -lh "$f"

echo "== 2. pull =="
sudo -u dev git pull --ff-only origin main | tail -1
sudo -u dev git rev-parse --short HEAD

echo "== 3. flags =="
for k in FEATURE_MOVIES NEXT_PUBLIC_FEATURE_MOVIES FEATURE_MUSIC NEXT_PUBLIC_FEATURE_MUSIC \
         FEATURE_NEWS NEXT_PUBLIC_FEATURE_NEWS FEATURE_GAMING NEXT_PUBLIC_FEATURE_GAMING \
         FEATURE_CRYPTO NEXT_PUBLIC_FEATURE_CRYPTO FEATURE_MESSENGER NEXT_PUBLIC_FEATURE_MESSENGER; do
  if grep -q "^$k=" infra/hetzner/.env.production; then
    sed -i "s/^$k=.*/$k=1/" infra/hetzner/.env.production
  else
    printf '%s=1\n' "$k" >> infra/hetzner/.env.production
  fi
done
if grep -q "^GEMINI_API_KEY=" infra/hetzner/.env.production; then
  sed -i "s/^GEMINI_API_KEY=.*/GEMINI_API_KEY=<REDACTAT>/" infra/hetzner/.env.production
else
  printf 'GEMINI_API_KEY=<REDACTAT>\n' >> infra/hetzner/.env.production
fi
if grep -q "^YOUTUBE_API_KEY=" infra/hetzner/.env.production; then
  sed -i "s/^YOUTUBE_API_KEY=.*/YOUTUBE_API_KEY=<REDACTAT>/" infra/hetzner/.env.production
else
  printf 'YOUTUBE_API_KEY=<REDACTAT>\n' >> infra/hetzner/.env.production
fi
grep -E '^(FEATURE|NEXT_PUBLIC_FEATURE)_(NEWS|GAMING|CRYPTO|MESSENGER|MOVIES|MUSIC)=' infra/hetzner/.env.production
stat -c '%A %U' infra/hetzner/.env.production

echo "== 4. migration ledger =="
PSQL=(docker exec -i swypik-prod-postgres-1 psql -v ON_ERROR_STOP=1 -U swypik -d swypik_prod)
"${PSQL[@]}" -tAc "select table_name from information_schema.tables where table_name in ('_applied_migrations','schema_migrations')"
"${PSQL[@]}" -tAc "select filename from _applied_migrations order by 1 desc limit 3" || true

echo "== 5. apply new migrations (idempotent) =="
for m in 20260921_0001_seller_erp.sql 20260921_0002_mystery_drop.sql 20260921_0003_movies.sql \
         20260921_0004_movies_visibility_guard.sql 20260921_0005_movie_watchlist.sql 20260922_0001_music.sql \
         20260923_0001_youtube_music_cache.sql \
         20260924_0001_messenger_whatsapp_calls.sql 20260924_0002_ai_news.sql \
         20260924_0003_gaming_module.sql 20260924_0004_crypto_transactions.sql; do
  [ -f "db/migrations/$m" ] || { echo "MISSING $m"; exit 1; }
  already=$("${PSQL[@]}" -tAc "select 1 from _applied_migrations where filename = '$m'" || true)
  if [ "$already" = "1" ]; then echo "skip (applied): $m"; continue; fi
  echo "apply: $m"
  "${PSQL[@]}" < "db/migrations/$m" > /dev/null
  "${PSQL[@]}" -c "insert into _applied_migrations (filename) values ('$m') on conflict do nothing" > /dev/null
  "${PSQL[@]}" -c "insert into schema_migrations (version) values ('${m%.sql}') on conflict do nothing" > /dev/null 2>&1 || true
done

echo "== 6. verify tables =="
"${PSQL[@]}" -tAc "select string_agg(table_name, ',') from information_schema.tables where table_name in ('movie_series','movie_episodes','movie_unlocks','movie_watchlist','music_artists','music_tracks','music_unlocks','music_tips','mystery_drop_claims','seller_sequences','youtube_music_cache','youtube_tracks')"
echo "STEP A OK"
