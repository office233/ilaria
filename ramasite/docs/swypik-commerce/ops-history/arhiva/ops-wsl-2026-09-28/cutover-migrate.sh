#!/usr/bin/env bash
# Aplică migrările din repo (commit-ul deploy-at pe Azure) pe baza Azure, o singură dată, cu ledger.
set -euo pipefail
MIG=/mnt/e/Swypik/swypik/app/db/migrations
O=(-i /root/.ssh/swypik_admin -o UserKnownHostsFile=/root/.ssh/azure_known_hosts -o ConnectTimeout=20 -o LogLevel=ERROR -o ServerAliveInterval=30)
PJ="ssh ${O[*]} -W %h:%p swypikadmin@4.165.143.236"
psql_data() { ssh "${O[@]}" -o ProxyCommand="$PJ" swypikadmin@10.60.2.10 "sudo docker exec -i swypik-postgres psql -q -v ON_ERROR_STOP=1 -tA -U swypik -d swypik_prod $*"; }
applied=$(echo "select version from schema_migrations;" | psql_data | sort -u)
pending=$(ls $MIG/*.sql | xargs -n1 basename | sed 's/\.sql$//' | sort | comm -23 - <(echo "$applied"))
n=$(echo "$pending" | grep -c . || true)
echo "în așteptare: $n"
[ "$n" -le 70 ] || { echo "prea multe — oprit"; exit 1; }
for m in $pending; do
  if psql_data < "$MIG/$m.sql" > /tmp/mig.out 2>&1; then
    echo "insert into schema_migrations (version) values ('$m') on conflict do nothing;" | psql_data >/dev/null
    echo "OK   $m"
  else
    echo "FAIL $m"; grep -vE NOTICE /tmp/mig.out | tail -5; exit 1
  fi
done
cat <<'SQL' | psql_data
select 'resync: ' || coalesce(social_resync_counters()::text, 'ok');
select 'users ' || count(*) from users;
select 'migr ' || count(*) || ' max ' || max(version) from schema_migrations;
select 'videos vizibile ' || count(*) from videos where is_hidden = false;
SQL
echo MIGRATE_OK
