set -euo pipefail
P="docker exec -i swypik-prod-postgres-1 psql -v ON_ERROR_STOP=1 -U swypik -d swypik_prod -tA"
$P -c "select version from schema_migrations" | sort -u > /tmp/sm.txt
ls /opt/swypik/app/db/migrations/*.sql | xargs -n1 basename | sed 's/\.sql$//' | sort > /tmp/files.txt
comm -23 /tmp/files.txt /tmp/sm.txt | awk '$0 < "20260924_0005"' > /tmp/backfill.txt
echo "backfilling $(wc -l < /tmp/backfill.txt) versions"
{ echo "BEGIN;"; while read v; do echo "INSERT INTO schema_migrations (version) VALUES ('$v') ON CONFLICT DO NOTHING;"; done < /tmp/backfill.txt; echo "COMMIT;"; } | $P > /dev/null
$P -c "select version from schema_migrations" | sort -u > /tmp/sm.txt
echo "still pending:"; comm -23 /tmp/files.txt /tmp/sm.txt
