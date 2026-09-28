#!/bin/bash
COMPOSE="/opt/swypik/app/infra/hetzner/docker-compose.prod.yml"

echo "=== Product stats ==="
docker compose -f $COMPOSE exec -T postgres psql -U swypik -d swypik -c "SELECT COUNT(*) as total_products, COUNT(video_url) as with_video FROM products;"

echo "=== Sample video URLs ==="
docker compose -f $COMPOSE exec -T postgres psql -U swypik -d swypik -c "SELECT id, LEFT(title,40) as title, LEFT(video_url,80) as video_url FROM products WHERE video_url IS NOT NULL AND video_url != '' LIMIT 5;"

echo "=== Video URL domains ==="
docker compose -f $COMPOSE exec -T postgres psql -U swypik -d swypik -c "SELECT SUBSTRING(video_url FROM 'https?://([^/]+)') as domain, COUNT(*) as cnt FROM products WHERE video_url IS NOT NULL AND video_url != '' GROUP BY domain ORDER BY cnt DESC LIMIT 10;"

echo "=== video_assets table ==="
docker compose -f $COMPOSE exec -T postgres psql -U swypik -d swypik -c "SELECT COUNT(*) FROM video_assets;" 2>/dev/null || echo "Table video_assets does not exist"
