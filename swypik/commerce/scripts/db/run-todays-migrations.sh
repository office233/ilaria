#!/usr/bin/env bash
# Aplica migrarile 20260730_* pe baza REALA (swypik_prod).
# Context: run-migrations.sh vechi tintea baza gresita ("swypik" in loc de
# "swypik_prod"), deci migrarile noi nu s-au aplicat.
set -uo pipefail
C=swypik-prod-postgres-1
DB=swypik_prod
DIR=/opt/swypik/app/db/migrations

for f in "$DIR"/20260730_*.sql; do
    name=$(basename "$f")
    echo "=== $name ==="
    docker exec -i "$C" psql -U swypik -d "$DB" -v ON_ERROR_STOP=0 < "$f" 2>&1 | tail -3
done

echo "=== verificare tabele ==="
for t in developer_accounts apps app_installs video_product_tags booking_slots video_attributions; do
    echo -n "$t: "
    docker exec "$C" psql -U swypik -d "$DB" -tAc "select to_regclass('public.$t') is not null"
done
