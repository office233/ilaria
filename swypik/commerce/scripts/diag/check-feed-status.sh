#!/bin/bash
PSQL="docker exec swypik-prod-postgres-1 psql -U swypik -d swypik_prod -tAc"
echo "=== videos + assets ==="
$PSQL "SELECT v.id, v.status AS video_status, va.status AS asset_status, v.visibility FROM videos v LEFT JOIN video_assets va ON va.video_id = v.id ORDER BY v.created_at DESC LIMIT 4;" 2>/dev/null \
  || $PSQL "SELECT v.id, v.status, va.status FROM videos v LEFT JOIN video_assets va ON va.video_id = v.id ORDER BY v.created_at DESC LIMIT 4;"
echo "=== coloane videos (statusuri posibile) ==="
$PSQL "SELECT column_name FROM information_schema.columns WHERE table_name = 'videos' ORDER BY ordinal_position;" | tr '\n' ' '
echo ""
echo "=== ce cere feed-ul (video published?) ==="
$PSQL "SELECT status, count(*) FROM videos GROUP BY 1;"
$PSQL "SELECT status, count(*) FROM video_assets GROUP BY 1;"
