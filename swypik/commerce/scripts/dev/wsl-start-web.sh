#!/bin/bash
set -e
cd /opt/swypik/app
COMPOSE="docker compose -f infra/hetzner/docker-compose.prod.yml -f infra/hetzner/docker-compose.vps.yml -f infra/hetzner/docker-compose.minio.yml --env-file infra/hetzner/.env.production"
$COMPOSE up -d web-next cron-worker 2>&1 | grep -viE 'warn|pull' | tail -4
sleep 12
docker ps --format '{{.Names}}\t{{.Status}}'
echo '--- health ---'
for i in $(seq 1 20); do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 3 http://localhost:3000/api/health 2>/dev/null || echo 000)
  [ "$CODE" = "200" ] && break
  sleep 3
done
echo "health: $CODE"
curl -s -m 5 http://localhost:3000/api/health | head -c 300
echo
docker logs swypik-prod-web-next-1 --tail 5 2>&1
