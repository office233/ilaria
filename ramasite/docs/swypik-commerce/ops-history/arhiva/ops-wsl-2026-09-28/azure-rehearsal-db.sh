#!/usr/bin/env bash
# Repetiție: dump prod (WSL) → transfer → restore pe nodul data Azure. Producția WSL nu e modificată.
set -euo pipefail
B=/opt/swypik/backups; mkdir -p $B
J=swypik-azure-jump
O=(-i /root/.ssh/swypik_admin -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/root/.ssh/azure_known_hosts -o ConnectTimeout=20 -o LogLevel=ERROR)
DATA=(ssh "${O[@]}" -o ProxyCommand="ssh ${O[*]} -W %h:%p swypikadmin@4.165.143.236" swypikadmin@10.60.2.10)
t0=$(date +%s)
docker exec swypik-prod-postgres-1 pg_dump -U swypik -d swypik_prod -Fc -Z 6 > $B/rehearsal-swypik.dump
MU=$(tr -d '\r' < /opt/multi-erp/.env | grep -E '^PG_USER=' | cut -d= -f2-); MD=$(tr -d '\r' < /opt/multi-erp/.env | grep -E '^PG_DATABASE=' | cut -d= -f2-)
docker exec multi-erp-postgres pg_dump -U "${MU:-multi}" -d "${MD:-multi_erp}" -Fc -Z 6 > $B/rehearsal-multi.dump
t1=$(date +%s); ls -lh $B/rehearsal-*.dump | awk '{print $5, $9}'
"${DATA[@]}" 'sudo install -d -m 750 -o dev -g dev /srv/data/backups && sudo install -m 600 -o dev -g dev /dev/stdin /srv/data/backups/rehearsal-swypik.dump' < $B/rehearsal-swypik.dump
"${DATA[@]}" 'sudo install -m 600 -o dev -g dev /dev/stdin /srv/data/backups/rehearsal-multi.dump' < $B/rehearsal-multi.dump
t2=$(date +%s)
"${DATA[@]}" 'sudo -iu dev bash -s' <<'REMOTE'
restore() { docker cp "$2" "$1":/tmp/restore.dump; docker exec "$1" sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges -j 2 /tmp/restore.dump 2>&1 | grep -v "already exists" | tail -5; rm /tmp/restore.dump'; }
restore swypik-postgres /srv/data/backups/rehearsal-swypik.dump
restore multi-erp-postgres /srv/data/backups/rehearsal-multi.dump
docker exec swypik-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select '\''users '\''||count(*) from users union all select '\''videos '\''||count(*) from videos union all select '\''orders '\''||count(*) from commerce_orders union all select '\''migrations '\''||count(*)||'\'' max '\''||max(version) from schema_migrations"'
docker exec multi-erp-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select '\''multi-erp tables '\''||count(*) from information_schema.tables where table_schema='\''public'\''"'
REMOTE
t3=$(date +%s)
echo "TIMP: dump $((t1-t0))s, transfer $((t2-t1))s, restore $((t3-t2))s"
docker exec swypik-prod-postgres-1 psql -U swypik -d swypik_prod -Atc "select 'WSL users '||count(*) from users union all select 'WSL videos '||count(*) from videos union all select 'WSL migrations '||count(*) from schema_migrations"
