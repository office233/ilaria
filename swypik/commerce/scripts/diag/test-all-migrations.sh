#!/bin/bash
# Ruleaza TOATE migrarile pe rand (ca deploy.sh) si raporteaza care pica.
# Migrarile trebuie sa fie idempotente — orice eroare = bug de idempotenta.
cd /opt/swypik/app
FAIL=0
for f in db/migrations/*.sql; do
  base=$(basename "$f")
  out=$(docker exec -i swypik-prod-postgres-1 psql -U swypik -d swypik_prod \
        -v ON_ERROR_STOP=1 -f "/docker-entrypoint-initdb.d/$base" 2>&1)
  if [ $? -ne 0 ]; then
    echo "FAIL: $base"
    echo "$out" | grep -E "ERROR" | head -2
    FAIL=1
  fi
done
[ $FAIL -eq 0 ] && echo "TOATE MIGRARILE TREC ✓"
