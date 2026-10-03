#!/bin/bash
# Copiaza fisierele modificate (lista pe stdin sau args) din /mnt/e in /opt si ruleaza tsc.
set -e
SRC=/mnt/e/Meister/swypik/app
DST=/opt/swypik/app
FILES="lib/swyp/chain-public.ts lib/swyp/chain.ts lib/risk/thresholds.ts lib/config/synthetic-engagement.ts lib/referral/attribution.ts components/ProductFeed.tsx app/api/v1/feed/route.ts app/api/webhooks/stripe/_handlers/payments.ts app/[locale]/pay/PayClient.tsx app/api/admin/import/route.ts .env.example"
for f in $FILES; do
  mkdir -p "$DST/$(dirname "$f")"
  sed 's/\r$//' "$SRC/$f" > "$DST/$f"
done
docker run --rm -v /opt/swypik/app:/app -w /app node:20-alpine sh -c 'npx tsc --noEmit > /tmp/tsc.out 2>&1; ec=$?; echo "TSC_EXIT=$ec"; grep -c "error TS" /tmp/tsc.out; tail -8 /tmp/tsc.out'
