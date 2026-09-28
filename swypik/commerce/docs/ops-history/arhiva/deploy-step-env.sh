#!/usr/bin/env bash
set -euo pipefail
cd /opt/swypik/app/infra/hetzner

for k in FEATURE_MOVIES NEXT_PUBLIC_FEATURE_MOVIES FEATURE_MUSIC NEXT_PUBLIC_FEATURE_MUSIC; do
  if grep -q "^$k=" .env.production; then
    sed -i "s/^$k=.*/$k=1/" .env.production
  else
    printf '%s=1\n' "$k" >> .env.production
  fi
done

if grep -q "^YOUTUBE_API_KEY=" .env.production; then
  sed -i "s/^YOUTUBE_API_KEY=.*/YOUTUBE_API_KEY=<REDACTAT>/" .env.production
else
  printf 'YOUTUBE_API_KEY=<REDACTAT>\n' >> .env.production
fi

echo "== verify env =="
grep -E '^(FEATURE|NEXT_PUBLIC_FEATURE)_(MOVIES|MUSIC)=' .env.production
grep -E '^YOUTUBE_API_KEY=' .env.production | cut -c 1-25
echo "ENV OK"
