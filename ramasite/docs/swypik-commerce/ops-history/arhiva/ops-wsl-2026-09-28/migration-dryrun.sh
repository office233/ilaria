#!/usr/bin/env bash
# Dry-run migrari pe o COPIE a DB de productie (container temporar). Productia nu e atinsa.
# Rulat ca root: wsl -d swypik -u root -- bash /mnt/e/Swypik/ops/migration-dryrun.sh <dir_migrari>
set -uo pipefail
MIG_DIR=${1:-/mnt/e/Swypik/swypik/app/db/migrations}
IMG=$(docker inspect -f '{{.Config.Image}}' swypik-prod-postgres-1)
NAME=swypik-migdry
docker rm -f $NAME >/dev/null 2>&1
docker run -d --name $NAME -e POSTGRES_USER=swypik -e POSTGRES_PASSWORD=dry -e POSTGRES_DB=swypik_prod "$IMG" >/dev/null
for i in $(seq 1 30); do docker exec $NAME pg_isready -U swypik >/dev/null 2>&1 && break; sleep 1; done
sleep 2
echo "imagine: $IMG"
docker exec swypik-prod-postgres-1 pg_dump -U swypik swypik_prod | docker exec -i $NAME psql -q -U swypik -d swypik_prod >/tmp/migdry-restore.log 2>&1
echo "restore: $(grep -c ERROR /tmp/migdry-restore.log) erori"
P=(docker exec -i $NAME psql -v ON_ERROR_STOP=1 -U swypik -d swypik_prod)
applied=$("${P[@]}" -tAc "select version from schema_migrations" | sort -u)
pending=$(ls $MIG_DIR/*.sql | xargs -n1 basename | sed 's/\.sql$//' | sort | comm -23 - <(echo "$applied"))
echo "in asteptare: $(echo "$pending" | grep -c .)"
fail=0
for m in $pending; do
  if out=$("${P[@]}" < "$MIG_DIR/$m.sql" 2>&1); then
    "${P[@]}" -c "insert into schema_migrations (version) values ('$m') on conflict do nothing" >/dev/null
    echo "OK   $m"
  else
    echo "FAIL $m"; echo "$out" | grep -E "ERROR|DETAIL|HINT|LINE" | head -6; fail=1; break
  fi
done
if [ $fail = 0 ]; then
  echo "== a doua rulare (idempotenta) =="
  for m in $pending; do
    "${P[@]}" < "$MIG_DIR/$m.sql" >/dev/null 2>&1 || echo "NE-IDEMPOTENTA: $m"
  done
  "${P[@]}" -tAc "select 'videos publice vizibile: '||count(*) from videos where is_hidden=false and visibility='public' and coalesce(effective_label,'safe')='safe'" 2>&1
fi
docker rm -f $NAME >/dev/null
echo "DRYRUN_DONE fail=$fail"
