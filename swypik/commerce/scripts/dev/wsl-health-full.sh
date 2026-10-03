#!/bin/bash
# Health complet al stack-ului local WSL dupa migrarea de pe VPS.
echo "=== WEB local ==="
curl -s -o /dev/null -w 'health: %{http_code}\n' -m 8 http://127.0.0.1:3000/api/health 2>/dev/null || echo "web NU raspunde pe 3000"

echo "=== CLOUDFLARED ==="
pgrep -a cloudflared | head -2 || echo "cloudflared NU ruleaza"
systemctl is-active cloudflared 2>/dev/null || service cloudflared status 2>/dev/null | head -2 || true

echo "=== PUBLIC: swypik.com ==="
curl -s -o /dev/null -w 'swypik.com: %{http_code}\n' -m 10 https://swypik.com/api/health

echo "=== CRON worker ==="
docker logs swypik-prod-cron-worker-1 --since 5m 2>&1 | tail -3
