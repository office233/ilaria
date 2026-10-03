#!/bin/bash
# Verificare pipeline video: config S3/MinIO, buckets, workeri, coada Redis.
echo "=== 1. ENV S3 in web-next ==="
docker exec swypik-prod-web-next-1 sh -c 'printenv | grep -E "^(S3_|R2_|VIDEO_)" | sed "s/=.*/=SET/"'
echo ""
echo "=== 2. MinIO: buckets si continut videos/ ==="
docker exec swypik-minio ls /data 2>/dev/null
echo "--- continut bucket (primele nivele) ---"
B=$(docker exec swypik-minio ls /data 2>/dev/null | head -1)
docker exec swypik-minio sh -c "find /data -maxdepth 3 -type d | head -15"
echo ""
echo "=== 3. Video workers ==="
docker ps --format '{{.Names}} {{.Status}}' | grep video-worker
echo "--- log worker 1 (ultimele erori/join) ---"
docker logs swypik-prod-video-worker-1 --tail 5 2>&1
echo ""
echo "=== 4. Coada Redis (video jobs) ==="
docker exec swypik-prod-redis-1 redis-cli KEYS '*video*' | head -5
docker exec swypik-prod-redis-1 redis-cli LLEN video:process:queue 2>/dev/null
echo ""
echo "=== 5. ffmpeg in worker ==="
docker exec swypik-prod-video-worker-1 sh -c 'which ffmpeg && ffmpeg -version 2>/dev/null | head -1'
echo ""
echo "=== 6. Tabele video (sesiuni + assets) ==="
docker exec swypik-prod-postgres-1 psql -U swypik -d swypik_prod -tAc "SELECT count(*) AS upload_sessions FROM video_upload_sessions;"
docker exec swypik-prod-postgres-1 psql -U swypik -d swypik_prod -tAc "SELECT count(*) AS assets FROM video_assets;"
docker exec swypik-prod-postgres-1 psql -U swypik -d swypik_prod -tAc "SELECT count(*) AS links FROM video_product_links;"
