#!/bin/bash
COMPOSE="/opt/swypik/app/infra/hetzner/docker-compose.prod.yml"

echo "=== marketplace_products ==="
docker compose -f $COMPOSE exec -T postgres psql -U swypik -d swypik -c "SELECT COUNT(*) FROM marketplace_products;"

echo "=== marketplace_product_variants ==="
docker compose -f $COMPOSE exec -T postgres psql -U swypik -d swypik -c "SELECT COUNT(*) FROM marketplace_product_variants;"

echo "=== marketplace_merchants ==="
docker compose -f $COMPOSE exec -T postgres psql -U swypik -d swypik -c "SELECT COUNT(*) FROM marketplace_merchants;"

echo "=== Sample products ==="
docker compose -f $COMPOSE exec -T postgres psql -U swypik -d swypik -c "SELECT id, LEFT(title,50) as title FROM marketplace_products LIMIT 5;"
