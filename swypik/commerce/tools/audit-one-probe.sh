#!/usr/bin/env bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -X PATCH -H "content-type: application/json" \
  --data-raw '{"action":"approve"}' \
  "http://localhost:3005/api/admin/fleet/00000000-0000-4000-8000-000000000000"
echo "exit=$?"
