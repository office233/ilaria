set -uo pipefail
O=(-i /root/.ssh/swypik_admin -o UserKnownHostsFile=/root/.ssh/azure_known_hosts -o ConnectTimeout=20 -o LogLevel=ERROR)
ssh "${O[@]}" -o ProxyCommand="ssh ${O[*]} -W %h:%p swypikadmin@4.165.143.236" swypikadmin@10.60.2.10 'sudo docker exec -i swypik-postgres psql -tA -U swypik -d swypik_prod' <<'SQL'
select 'AZURE users ' || count(*) from users;
select 'AZURE migr ' || count(*) || ' max ' || max(version) from schema_migrations;
SQL
docker exec -i swypik-prod-postgres-1 psql -tA -U swypik -d swypik_prod <<'SQL'
select 'WSL users ' || count(*) from users;
select 'WSL migr ' || count(*) from schema_migrations;
SQL
