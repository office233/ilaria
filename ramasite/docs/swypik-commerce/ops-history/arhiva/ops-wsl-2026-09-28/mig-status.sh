P="docker exec swypik-prod-postgres-1 psql -U swypik -d swypik_prod -tAc"
$P "select version from schema_migrations" | sort -u > /tmp/sm.txt
$P "select regexp_replace(filename,'\.sql$','') from _applied_migrations" 2>/dev/null | sort -u > /tmp/am.txt
ls /opt/swypik/app/db/migrations/*.sql | xargs -n1 basename | sed 's/\.sql$//' | sort > /tmp/files.txt
echo "files: $(wc -l < /tmp/files.txt)  schema_migrations: $(wc -l < /tmp/sm.txt)  _applied_migrations: $(wc -l < /tmp/am.txt)"
echo "== not in EITHER ledger (would be applied):"
sort -u /tmp/sm.txt /tmp/am.txt > /tmp/both.txt
comm -23 /tmp/files.txt /tmp/both.txt
