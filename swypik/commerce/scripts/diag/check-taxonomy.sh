#!/bin/bash
Q() { docker exec swypik-prod-postgres-1 psql -U swypik -d swypik_prod -t -A -c "$1"; }
echo "noduri taxonomy: $(Q 'select count(1) from taxonomy_nodes')"
echo "fashion-women exista: $(Q "select count(1) from taxonomy_nodes where slug='fashion-women'")"
echo "traduceri existente: $(Q 'select count(1) from taxonomy_translations')"
echo "-- migrari taxonomy in ordine --"
ls /opt/swypik/app/db/migrations/ | grep -i taxonomy
