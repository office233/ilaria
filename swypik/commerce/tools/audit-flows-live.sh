#!/usr/bin/env bash
# Probe fluxuri publice sectiunea B (fara sesiune) — smoke functional
B="http://localhost:3005"

echo '=== warmup ==='
for u in /api/v1/feed /api/products; do curl -s -o /dev/null "${B}${u}"; sleep 0.3; done

echo
echo '=== FEED (public) ==='
curl -s "${B}/api/v1/feed?limit=2" | head -c 400; echo

echo
echo '=== PRODUCTS list (public) ==='
curl -s -o /dev/null -w 'GET /api/products -> %{http_code}\n' "${B}/api/products?limit=2"

echo
echo '=== WALLET fara sesiune (asteptam 401) ==='
curl -s -o /dev/null -w 'GET /api/me/activity -> %{http_code}\n' "${B}/api/me/activity"

echo
echo '=== CART add fara produs valid (asteptam 400/404, nu 500) ==='
curl -s -o /dev/null -w 'POST /api/cart/items bad -> %{http_code}\n' -X POST -H 'content-type: application/json' --data-raw '{}' "${B}/api/cart/items"

echo
echo '=== CHECKOUT create-intent fara body (asteptam 400, nu 500) ==='
curl -s -o /dev/null -w 'POST /api/checkout/create-intent empty -> %{http_code}\n' -X POST -H 'content-type: application/json' --data-raw '{}' "${B}/api/checkout/create-intent"

echo
echo '=== RIDES estimate fara body (FEATURE_GO?) ==='
curl -s -o /dev/null -w 'POST /api/rides/estimate empty -> %{http_code}\n' -X POST -H 'content-type: application/json' --data-raw '{}' "${B}/api/rides/estimate"
echo '=== DONE ==='
