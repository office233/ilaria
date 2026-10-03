#!/usr/bin/env bash
# CUTOVER: îngheață scrierile pe WSL, dump final, restore pe Azure (baza curată), migrări, flush Redis.
set -euo pipefail
B=/opt/swypik/backups
O=(-i /root/.ssh/swypik_admin -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/root/.ssh/azure_known_hosts -o ConnectTimeout=20 -o LogLevel=ERROR -o ServerAliveInterval=30)
PJ="ssh ${O[*]} -W %h:%p swypikadmin@4.165.143.236"
DATA=(ssh "${O[@]}" -o ProxyCommand="$PJ" swypikadmin@10.60.2.10)
WEB1=(ssh "${O[@]}" -o ProxyCommand="$PJ" swypikadmin@10.60.1.10)
ts() { date +%H:%M:%S; }
echo "[$(ts)] 1. opresc site-ul + scrierile pe WSL (rollback: docker start swypik-prod-web-next-1)"
for c in swypik-prod-web-next-1 swypik-prod-cron-worker-1 swypik-prod-video-worker-1 swypik-prod-video-worker-2 swypik-prod-video-worker-3 swypik-dispatch; do docker stop -t 20 $c >/dev/null 2>&1 && echo "  oprit $c" || true; done
echo "[$(ts)] 2. dump final"
docker exec swypik-prod-postgres-1 pg_dump -U swypik -d swypik_prod -Fc -Z 6 > $B/cutover-swypik.dump
ls -lh $B/cutover-swypik.dump | awk '{print "  "$5}'
echo "[$(ts)] 3. transfer"
"${DATA[@]}" 'sudo install -m 600 -o dev -g dev /dev/stdin /srv/data/backups/cutover-swypik.dump' < $B/cutover-swypik.dump
echo "[$(ts)] 4. restore pe baza curată"
"${DATA[@]}" 'sudo -iu dev bash -s' <<'REMOTE'
set -euo pipefail
docker exec swypik-postgres sh -c 'psql -q -U "$POSTGRES_USER" -d postgres -c "DROP DATABASE $POSTGRES_DB WITH (FORCE)" -c "CREATE DATABASE $POSTGRES_DB OWNER $POSTGRES_USER"'
docker cp /srv/data/backups/cutover-swypik.dump swypik-postgres:/tmp/r.dump
docker exec swypik-postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges -j 2 /tmp/r.dump 2>&1 | grep -vi "already exists" | tail -5; rm /tmp/r.dump'
REDIS_PASSWORD=$(grep -E '^REDIS_PASSWORD=' /opt/swypik/env/data.env | cut -d= -f2-)
docker exec swypik-redis redis-cli -a "$REDIS_PASSWORD" --no-auth-warning FLUSHALL
REMOTE
echo "[$(ts)] 5. migrări noi (din web-1)"
"${WEB1[@]}" 'sudo -iu dev bash -s' <<'REMOTE'
set -euo pipefail
D=(ssh -i /home/dev/.ssh/swypik_deploy -o LogLevel=ERROR dev@10.60.2.10)
PSQL='docker exec -i swypik-postgres sh -c "psql -q -v ON_ERROR_STOP=1 -U \$POSTGRES_USER -d \$POSTGRES_DB"'
applied=$("${D[@]}" "docker exec swypik-postgres sh -c 'psql -tA -U \$POSTGRES_USER -d \$POSTGRES_DB -c \"select version from schema_migrations\"'" | sort -u)
pending=$(ls /opt/swypik/app/db/migrations/*.sql | xargs -n1 basename | sed 's/\.sql$//' | sort | comm -23 - <(echo "$applied"))
echo "  în așteptare: $(echo "$pending" | grep -c . || true)"
for m in $pending; do
  "${D[@]}" "$PSQL" < /opt/swypik/app/db/migrations/$m.sql 2>&1 | grep -vE 'NOTICE|^$' | head -3 || true
  echo "insert into schema_migrations (version) values ('$m') on conflict do nothing" | "${D[@]}" "$PSQL"
done
"${D[@]}" "docker exec swypik-postgres sh -c 'psql -tA -U \$POSTGRES_USER -d \$POSTGRES_DB -c \"select social_resync_counters()\" -c \"select count(*) from users\" -c \"select count(*) from schema_migrations\"'"
REMOTE
echo "[$(ts)] CUTOVER_DB_OK"
