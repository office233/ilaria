#!/bin/bash
set -euo pipefail
cd /opt/swypik/app

# Rate-limited enqueue: 500 jobs/run la fiecare 5min = max ~6000/h
# Aceasta corespunde aproximativ cu throughput-ul workerilor (3 workeri * ~3 jobs/min = ~540/h sustained)
# Dar avem buffer pentru spike-uri si recovery
LIMIT="${ENQUEUE_LIMIT:-500}"

docker cp /opt/swypik/app/scripts/enqueue-ae-videos.mjs swypik-prod-web-next-1:/tmp/enqueue-ae-videos.mjs
docker exec swypik-prod-web-next-1 sh -c 'rm -rf /tmp/node_modules && ln -s /app/node_modules /tmp/node_modules'
docker exec -w /tmp swypik-prod-web-next-1 node /tmp/enqueue-ae-videos.mjs --limit="$LIMIT"
