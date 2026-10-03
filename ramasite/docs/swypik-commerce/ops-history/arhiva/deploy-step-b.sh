#!/usr/bin/env bash
# Pasul B al deploy-ului local: build web-next cu metadate de release, recreate, smoke test.
# Rulat ca root: bash /mnt/e/Swypik/deploy-step-b.sh   (durează câteva minute)
echo "== sync code from host =="
rsync -a --exclude=node_modules --exclude=.next --exclude=.git /mnt/e/Swypik/swypik/app/ /opt/swypik/app/ || cp -ru /mnt/e/Swypik/swypik/app/components /mnt/e/Swypik/swypik/app/app /mnt/e/Swypik/swypik/app/lib /opt/swypik/app/

cd /opt/swypik/app/infra/hetzner
sed -i "s/^GEMINI_API_KEY=.*/GEMINI_API_KEY=<REDACTAT>/" .env.production 2>/dev/null || true
sed -i "s/^FEATURE_MOVIES=.*/FEATURE_MOVIES=1/" .env.production 2>/dev/null || true
sed -i "s/^FEATURE_MUSIC=.*/FEATURE_MUSIC=1/" .env.production 2>/dev/null || true
sed -i "s/^NEXT_PUBLIC_FEATURE_MOVIES=.*/NEXT_PUBLIC_FEATURE_MOVIES=1/" .env.production 2>/dev/null || true
sed -i "s/^NEXT_PUBLIC_FEATURE_MUSIC=.*/NEXT_PUBLIC_FEATURE_MUSIC=1/" .env.production 2>/dev/null || true

COMMIT_LONG=$(git -c safe.directory=/opt/swypik/app -C /opt/swypik/app rev-parse HEAD)
COMMIT=${COMMIT_LONG:0:8}
export BUILD_COMMIT="$COMMIT_LONG"
export BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
export DEPLOYED_AT="$BUILD_TIME"
COMPOSE=(docker compose -p swypik-prod --env-file .env.production -f docker-compose.prod.yml -f docker-compose.vps.yml -f docker-compose.minio.yml)

echo "== rollback tag =="
docker tag swypik-prod-web-next:latest swypik-prod-web-next:rollback

echo "== build ($COMMIT) =="
"${COMPOSE[@]}" build web-next 2>&1 | tail -15

echo "== recreate =="
"${COMPOSE[@]}" up -d --no-deps --force-recreate web-next 2>&1 | tail -3

echo "== health (max 120s) =="
sleep 8
for i in $(seq 1 24); do
  body=$(curl -s -m 8 http://127.0.0.1:3005/api/health || true)
  if echo "$body" | grep -q '"status":"ok"'; then echo "healthy: $body after $((i*5))s"; break; fi
  sleep 5
  [ "$i" = 24 ] && { echo "HEALTH TIMEOUT: $body"; docker logs --tail 40 swypik-prod-web-next-1; exit 1; }
done

echo "== smoke (public) =="
for p in /api/health /api/movies/home /api/music/home /movies /music /ro/movies /ro/music \
             /news /ro/news /gaming /ro/gaming /crypto/market /ro/crypto/market /messages /ro/messages; do
  printf '%-18s ' "$p"; curl -s -m 15 -o /dev/null -w '%{http_code}\n' "https://swypik.com$p"
done
echo "STEP B OK"
