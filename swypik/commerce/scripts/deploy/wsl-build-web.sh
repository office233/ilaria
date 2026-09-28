#!/bin/bash
cd /opt/swypik/app
nohup docker compose -f infra/hetzner/docker-compose.prod.yml \
  -f infra/hetzner/docker-compose.vps.yml \
  -f infra/hetzner/docker-compose.minio.yml \
  --env-file infra/hetzner/.env.production \
  build web-next > /tmp/build-local.log 2>&1 &
echo "BUILD_STARTED pid=$!"
