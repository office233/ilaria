#!/bin/bash
docker ps --format '{{.Names}}\t{{.Status}}'
echo '--- chain rpc ---'
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' http://localhost:8545
echo
echo '--- postgres swypik ---'
PGC=$(docker ps --format '{{.Names}}' | grep postgres | grep -v bs | grep -v multi | head -1)
[ -n "$PGC" ] && docker exec $PGC psql -U swypik -d swypik_prod -tAc "SELECT 'users='||count(*) FROM users" 2>&1 | head -2
echo '--- minio ---'
docker ps --format '{{.Names}}' | grep -c minio
