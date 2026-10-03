#!/usr/bin/env bash
# Smoke test verticalele de mobilitate dupa deploy.
set -uo pipefail
B=https://swypik.com
chk() { printf '%-34s %s\n' "$1" "$(curl -s -o /dev/null -w '%{http_code}' "$B$2")"; }

echo "== pagini =="
chk "/ (home)"            /
chk "/ro/food (Eats)"     /ro/food
chk "/ro/go (Swypik Go)"  /ro/go
chk "/ro/orders"          /ro/orders
chk "/manifest.json"      /manifest.json
chk "/offline.html"       /offline.html

echo "== API (fara auth: 401/403 = ruta exista si e protejata) =="
chk "/api/health"                 /api/health
chk "/api/me/activity"            /api/me/activity
chk "/api/rides/estimate"         /api/rides/estimate
chk "/api/couriers/earnings"      /api/couriers/earnings

echo "== tabele mobilitate =="
for t in rides dispatch_jobs pricing_zones surge_rules payout_requests merchant_settlements reconciliation_issues; do
    printf '%-26s ' "$t"
    docker exec swypik-prod-postgres-1 psql -U swypik -d swypik_prod -tAc \
      "select to_regclass('public.$t') is not null"
done
