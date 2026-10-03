#!/bin/bash
# Ruleaza migrarile de la 20260519_0011 incolo (unde a ajuns deployul) si
# raporteaza DOAR erorile reale (nu NOTICE-uri).
cd /opt/swypik/app
FAILED=""
for f in db/migrations/*.sql; do
  base=$(basename "$f")
  # sarim peste cele dinainte de punctul de esec
  [[ "$base" < "20260519_0011" ]] && continue
  out=$(docker exec -i swypik-prod-postgres-1 psql -U swypik -d swypik_prod \
        -v ON_ERROR_STOP=1 < "$f" 2>&1)
  if [ $? -ne 0 ]; then
    echo "FAIL: $base"
    echo "$out" | grep ERROR | head -1
    FAILED=1
  fi
done
[ -z "$FAILED" ] && echo "TOATE MIGRARILE RAMASE TREC"
