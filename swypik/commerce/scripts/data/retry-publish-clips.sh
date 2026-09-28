#!/bin/bash
# 1) Sterge incercarea esuata oras_seara si o reimporta;
# 2) publica toate clipurile de test procesate (ready + draft -> public).
set -e
PSQL="docker exec swypik-prod-postgres-1 psql -U swypik -d swypik_prod -tAc"

echo "=== sterg esecul oras_seara ==="
$PSQL "DELETE FROM video_assets WHERE video_id IN (SELECT id FROM videos WHERE status='failed' AND 'test-content' = ANY(tags));"
$PSQL "DELETE FROM video_upload_sessions WHERE video_id IN (SELECT id FROM videos WHERE status='failed' AND 'test-content' = ANY(tags));"
$PSQL "DELETE FROM videos WHERE status='failed' AND 'test-content' = ANY(tags);"

echo "=== reimport oras_seara ==="
mkdir -p /tmp/test-clips/retry
cp /tmp/test-clips/out/oras_seara.mp4 /tmp/test-clips/retry/
bash /tmp/itc.sh /tmp/test-clips/retry

echo "=== publicare: toate clipurile test ready -> public ==="
$PSQL "UPDATE videos SET visibility='public', published_at = COALESCE(published_at, now()) WHERE status='ready' AND 'test-content' = ANY(tags);" 2>/dev/null \
  || $PSQL "UPDATE videos SET visibility='public' WHERE status='ready' AND 'test-content' = ANY(tags);"

echo "=== stare finala ==="
$PSQL "SELECT title, status, visibility FROM videos WHERE 'test-content' = ANY(tags) ORDER BY title;"
echo "=== feed public ==="
curl -s 'https://swypik.com/api/explore/feed?limit=10' | python3 -c "import json,sys;d=json.load(sys.stdin);vs=d.get('videos',[]);print('videos in feed:',len(vs));[print(' -',v.get('title')) for v in vs]"
