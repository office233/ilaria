#!/usr/bin/env bash
# Probe live: auth-gating, input validation (400 nu 500), IDOR cu ID-uri random
B="http://localhost:3005"
UUID="00000000-0000-4000-8000-000000000000"

probe() { # metoda url descriere [body]
	local m="$1" u="$2" d="$3" body="${4:-}"
	local url="${B}${u}"
	local code
	if [ -n "$body" ]; then
		code=$(curl -s -o /dev/null -w '%{http_code}' -X "$m" -H 'content-type: application/json' --data-raw "$body" "$url")
	else
		code=$(curl -s -o /dev/null -w '%{http_code}' -X "$m" "$url")
	fi
	printf '%-6s %-52s %s -> %s\n' "$m" "$u" "$d" "$code"
	sleep 0.15
}

echo '=== warmup (compilare la rece Next.js) ==='
for u in "/api/admin/fleet/$UUID" "/api/developers/apps/$UUID/rotate-secret" "/api/seller/orders/$UUID/refund" "/api/seller/orders/$UUID/return/accept"; do
	curl -s -o /dev/null "${B}${u}"; sleep 0.3
done
echo
echo '=== AUTH-GATING (asteptam 401/403, NU 200/500) ==='
probe PATCH "/api/admin/fleet/$UUID" 'admin fleet fara sesiune' '{"action":"approve"}'
probe PATCH "/api/admin/fleet-partners/$UUID" 'admin fleet-partners' '{"action":"approve"}'
probe POST  "/api/developers/apps/$UUID/rotate-secret" 'rotate-secret fara developer'
probe POST  "/api/seller/orders/$UUID/refund" 'seller refund fara seller' '{}'
probe POST  "/api/seller/orders/$UUID/return/accept" 'seller return accept' '{}'
probe POST  "/api/merchants/$UUID/menu" 'merchant menu POST fara seller' '{}'

echo
echo '=== IDOR: order lookup cu UUID random (asteptam 404, NU date) ==='
probe GET "/api/orders/$UUID" 'order lookup UUID necunoscut'
probe POST "/api/orders/$UUID/return" 'order return UUID random' '{"reason":"x","token":"bad"}'

echo
echo '=== INPUT VALIDATION (payload malformat -> 400, NU 500) ==='
probe POST "/api/orders/$UUID/return" 'return body gol' '{}'
probe POST "/api/orders/$UUID/return" 'return JSON invalid' 'not-json{'

echo
echo '=== RATE LIMIT (order-lookup 30/min) — 3 hituri rapide ==='
for i in 1 2 3; do probe GET "/api/orders/$UUID" "lookup #$i"; done
echo '=== DONE ==='