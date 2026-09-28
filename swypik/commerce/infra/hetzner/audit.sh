#!/bin/bash
echo "╔══════════════════════════════════════════════════════════════════╗"
echo "║        SWYPIK VPS — FULL SYSTEM AUDIT (READ-ONLY)              ║"
echo "║        $(date '+%Y-%m-%d %H:%M:%S UTC')                               ║"
echo "╚══════════════════════════════════════════════════════════════════╝"

COMPOSE="/opt/swypik/app/infra/hetzner/docker-compose.prod.yml"

echo ""
echo "═══════════════════════════════════════"
echo "  1. SERVER RESOURCES"
echo "═══════════════════════════════════════"
echo "  Hostname: $(hostname)"
echo "  OS: $(cat /etc/os-release | grep PRETTY_NAME | cut -d= -f2 | tr -d '"')"
echo "  Kernel: $(uname -r)"
echo "  CPU: $(nproc) cores"
echo "  RAM:"
free -h | sed 's/^/    /'
echo "  Disk:"
df -h / | tail -1 | sed 's/^/    /'
echo "  Uptime: $(uptime -p)"
echo "  Load: $(cat /proc/loadavg | awk '{print $1, $2, $3}')"

echo ""
echo "═══════════════════════════════════════"
echo "  2. DOCKER CONTAINERS (7 expected)"
echo "═══════════════════════════════════════"
docker compose -f $COMPOSE ps --format 'table {{.Name}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null | sed 's/^/  /'

echo ""
echo "═══════════════════════════════════════"
echo "  3. PAGES — HTTP STATUS"  
echo "═══════════════════════════════════════"
for path in "/" "/account" "/explore" "/challenges" "/shop" "/collections" "/creator/dashboard"; do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "https://swypik.com${path}" 2>/dev/null)
  SIZE=$(curl -s -o /dev/null -w "%{size_download}" --max-time 5 "https://swypik.com${path}" 2>/dev/null)
  printf "  %-30s → HTTP %s  (%s bytes)\n" "https://swypik.com${path}" "$CODE" "$SIZE"
done

echo ""
echo "═══════════════════════════════════════"
echo "  4. API ENDPOINTS"
echo "═══════════════════════════════════════"
for path in "/api/products?limit=1" "/api/explore/feed?limit=1" "/api/challenges" "/api/rewards/wallet" "/api/collections" "/api/auth"; do
  RESP=$(curl -s --max-time 5 "https://swypik.com${path}" 2>/dev/null)
  CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "https://swypik.com${path}" 2>/dev/null)
  BODY=$(echo "$RESP" | cut -c1-100)
  printf "  %-35s → HTTP %s | %s\n" "$path" "$CODE" "$BODY"
done

echo ""
echo "═══════════════════════════════════════"
echo "  5. GO PLATFORM API (api.swypik.com)"
echo "═══════════════════════════════════════"
for path in "/healthz" "/readyz" "/v1/feed"; do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "https://api.swypik.com${path}" 2>/dev/null)
  printf "  %-40s → HTTP %s\n" "https://api.swypik.com${path}" "$CODE"
done

echo ""
echo "═══════════════════════════════════════"
echo "  6. SSL / TLS / PERFORMANCE"
echo "═══════════════════════════════════════"
curl -s -o /dev/null -w "  Protocol: HTTP/%{http_version}\n  SSL Verify: %{ssl_verify_result} (0=OK)\n  DNS: %{time_namelookup}s\n  Connect: %{time_connect}s\n  TLS: %{time_appconnect}s\n  TTFB: %{time_starttransfer}s\n  Total: %{time_total}s\n" "https://swypik.com/" 2>/dev/null

echo ""
echo "═══════════════════════════════════════"
echo "  7. DATABASE — TABLE STATS"
echo "═══════════════════════════════════════"
docker compose -f $COMPOSE exec -T postgres psql -U swypik -d swypik -c "
SELECT schemaname || '.' || relname AS table_name,
       n_live_tup AS row_count
FROM pg_stat_user_tables
WHERE n_live_tup > 0
ORDER BY n_live_tup DESC;" 2>/dev/null | sed 's/^/  /'

echo ""
echo "═══════════════════════════════════════"
echo "  8. DATABASE — KEY METRICS"
echo "═══════════════════════════════════════"
docker compose -f $COMPOSE exec -T postgres psql -U swypik -d swypik -t -c "
SELECT 'Total tables' AS metric, COUNT(*)::text AS value FROM information_schema.tables WHERE table_schema='public'
UNION ALL SELECT 'Videos in feed', COUNT(*)::text FROM videos WHERE status='ready' AND visibility='public'
UNION ALL SELECT 'Videos with video_url', COUNT(*)::text FROM videos WHERE playback_url IS NOT NULL AND playback_url != ''
UNION ALL SELECT 'Marketplace products', COUNT(*)::text FROM marketplace_products

UNION ALL SELECT 'AE variants', COUNT(*)::text FROM ae_variants
UNION ALL SELECT 'AE categories', COUNT(*)::text FROM ae_categories
UNION ALL SELECT 'Users', COUNT(*)::text FROM users
UNION ALL SELECT 'User sessions', COUNT(*)::text FROM user_sessions
UNION ALL SELECT 'Orders', COUNT(*)::text FROM commerce_orders
;" 2>/dev/null | sed 's/^/  /'

echo ""
echo "═══════════════════════════════════════"
echo "  9. SAMPLE FEED VIDEO (first entry)"
echo "═══════════════════════════════════════"
docker compose -f $COMPOSE exec -T postgres psql -U swypik -d swypik -t -c "
SELECT 'ID: ' || id || E'\n' ||
       'Title: ' || LEFT(title, 60) || E'\n' ||
       'Video URL: ' || LEFT(playback_url, 70) || E'\n' ||
       'Thumbnail: ' || LEFT(COALESCE(thumbnail_url,'(none)'), 70) || E'\n' ||
       'Status: ' || status || ' | Vis: ' || visibility || E'\n' ||
       'Views: ' || view_count || ' | Likes: ' || like_count || ' | Shares: ' || share_count
FROM videos WHERE status='ready' LIMIT 1;" 2>/dev/null | sed 's/^/  /'

echo ""
echo "═══════════════════════════════════════"
echo "  10. VIDEO CDN ACCESSIBILITY"
echo "═══════════════════════════════════════"
VIDEO_URL=$(docker compose -f $COMPOSE exec -T postgres psql -U swypik -d swypik -t -c "SELECT playback_url FROM videos WHERE status='ready' AND playback_url LIKE 'http%' LIMIT 1;" 2>/dev/null | tr -d ' \n')
echo "  Test URL: $VIDEO_URL"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -L --max-time 10 -r 0-1000 "$VIDEO_URL" 2>/dev/null)
echo "  HTTP Response (with -L follow redirect): $CODE"

echo ""
echo "═══════════════════════════════════════"
echo "  11. ENVIRONMENT VARIABLES (masked)"
echo "═══════════════════════════════════════"
if [ -f /opt/swypik/app/infra/hetzner/.env.production ]; then
  while IFS= read -r line; do
    if [[ "$line" =~ ^# ]] || [[ -z "$line" ]]; then
      echo "  $line"
    else
      KEY=$(echo "$line" | cut -d= -f1)
      VAL=$(echo "$line" | cut -d= -f2-)
      MASKED=$(echo "$VAL" | sed 's/./*/g' | cut -c1-20)
      printf "  %-35s = %s\n" "$KEY" "${VAL:0:4}${MASKED:4}"
    fi
  done < /opt/swypik/app/infra/hetzner/.env.production
fi

echo ""
echo "═══════════════════════════════════════"
echo "  12. DOCKER VOLUMES & STORAGE"
echo "═══════════════════════════════════════"
docker volume ls --format 'table {{.Name}}\t{{.Driver}}' 2>/dev/null | grep swypik | sed 's/^/  /'
echo "  ---"
echo "  Docker disk usage:"
docker system df 2>/dev/null | sed 's/^/    /'

echo ""
echo "═══════════════════════════════════════"
echo "  13. CADDY CONFIG (domains)"
echo "═══════════════════════════════════════"
grep -E '^[a-z].*\{' /opt/swypik/app/infra/hetzner/Caddyfile 2>/dev/null | sed 's/^/  /'
echo "  Certificates:"
ls -la /var/lib/docker/volumes/swypik-prod_swypik_caddy_data/_data/caddy/certificates/ 2>/dev/null | head -5 | sed 's/^/    /' || echo "    (volume internal)"

echo ""
echo "═══════════════════════════════════════"
echo "  14. RECENT LOGS (errors only)"
echo "═══════════════════════════════════════"
echo "  --- web-next ---"
docker compose -f $COMPOSE logs web-next --tail 20 2>&1 | grep -i "error\|ERR\|WARN\|fatal" | tail -5 | sed 's/^/    /' || echo "    No errors"
echo "  --- platform-api ---"
docker compose -f $COMPOSE logs platform-api --tail 20 2>&1 | grep -i "error\|ERR\|WARN\|fatal" | tail -5 | sed 's/^/    /' || echo "    No errors"
echo "  --- video-worker ---"
docker compose -f $COMPOSE logs video-worker --tail 20 2>&1 | grep -i "error\|ERR\|WARN\|fatal" | tail -5 | sed 's/^/    /' || echo "    No errors"
echo "  --- caddy ---"
docker compose -f $COMPOSE logs caddy --tail 20 2>&1 | grep -i "error\|ERR\|WARN\|fatal" | tail -3 | sed 's/^/    /' || echo "    No errors"

echo ""
echo "═══════════════════════════════════════"
echo "  15. NETWORK / FIREWALL"
echo "═══════════════════════════════════════"
echo "  Listening ports:"
ss -tlnp 2>/dev/null | grep -E "80|443|5432|3000|8080|6379" | sed 's/^/    /'
echo "  UFW status:"
ufw status 2>/dev/null | head -5 | sed 's/^/    /' || echo "    UFW not active"

echo ""
echo "═══════════════════════════════════════"
echo "  16. DNS VERIFICATION"
echo "═══════════════════════════════════════"
for domain in swypik.com www.swypik.com api.swypik.com; do
  IP=$(dig +short "$domain" @8.8.8.8 2>/dev/null || echo "n/a")
  printf "  %-25s → %s\n" "$domain" "$IP"
done

echo ""
echo "╔══════════════════════════════════════════════════════════════════╗"
echo "║                    AUDIT COMPLETE                              ║"
echo "╚══════════════════════════════════════════════════════════════════╝"
