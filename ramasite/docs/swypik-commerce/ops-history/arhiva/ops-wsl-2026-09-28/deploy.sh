#!/usr/bin/env bash
# Deploy Swypik în producție (distro WSL `swypik`), DOAR din git.
# Rulat ca root:  wsl -d swypik -u root -- bash /mnt/e/Swypik/ops/deploy.sh [--flags "FEATURE_X FEATURE_Y"] [--max-migrations N]
#   --services "video-worker cron-worker platform-api": reconstruiește și acele servicii
#                       (după ce web-next e sănătos) — când s-au schimbat workers/, cron-worker/run.sh, services/.
#   --max-migrations N: ridică explicit limita de migrări noi (implicit 10) — doar după un
#                       dry-run reușit pe copia DB (ops/migration-dryrun.sh).
#
# Pași: lock (un singur deploy o dată) → backup DB → git pull --ff-only (refuză clona murdară)
#       → migrări noi (ledger schema_migrations) → [flag-uri opționale] → build → recreate → health (commit) → smoke.
# Nu conține chei/secrete: toate vin din infra/hetzner/.env.production.
set -euo pipefail

APP=/opt/swypik/app
ENV_FILE=$APP/infra/hetzner/.env.production
LOCK=/run/swypik-deploy.lock
G=(git -c safe.directory=$APP -C $APP)

FLAGS=""
MAX_MIG=10
EXTRA_SERVICES=""
while [ $# -gt 0 ]; do
  case "$1" in
    --flags) FLAGS="$2"; shift 2 ;;
    --max-migrations) MAX_MIG="$2"; shift 2 ;;
    --services) EXTRA_SERVICES="$2"; shift 2 ;;
    *) echo "argument necunoscut: $1"; exit 2 ;;
  esac
done

exec 9>"$LOCK"
if ! flock -n 9; then
  echo "ALT DEPLOY RULEAZĂ DEJA (lock $LOCK) — opresc."; exit 1
fi

echo "== 1. clona live curată? =="
if [ -n "$("${G[@]}" status --porcelain --untracked-files=no)" ]; then
  "${G[@]}" status --short --untracked-files=no
  echo "Clona din $APP are modificări locale — deploy-ul se face DOAR din git. Oprit."; exit 1
fi

echo "== 2. backup DB =="
mkdir -p /opt/swypik/backups
f="/opt/swypik/backups/pre-deploy-$(date +%Y%m%d-%H%M).sql.gz"
docker exec swypik-prod-postgres-1 pg_dump -U swypik swypik_prod | gzip > "$f"
ls -lh "$f"

echo "== 3. git pull =="
sudo -u dev git -C $APP pull --ff-only origin main | tail -1
COMMIT_LONG=$("${G[@]}" rev-parse HEAD)
echo "HEAD: ${COMMIT_LONG:0:8}"

echo "== 4. migrări noi =="
PSQL=(docker exec -i swypik-prod-postgres-1 psql -v ON_ERROR_STOP=1 -U swypik -d swypik_prod)
# Protecție (2026-09-25): ledger-ul a fost incomplet și un deploy a re-rulat migrări vechi.
# Refuzăm dacă sunt prea multe migrări în așteptare sau dacă vreuna e MAI VECHE decât
# ultima aplicată — asta înseamnă ledger desincronizat, nu migrare nouă.
applied=$("${PSQL[@]}" -tAc "select version from schema_migrations" | sort -u)
latest=$(echo "$applied" | tail -1)
pending=$(ls $APP/db/migrations/*.sql | xargs -n1 basename | sed 's/\.sql$//' | sort | comm -23 - <(echo "$applied"))
count=$(echo "$pending" | grep -c . || true)
echo "migrări în așteptare: $count (ultima aplicată: $latest)"
[ -n "$pending" ] && echo "$pending"
if [ "$count" -gt "$MAX_MIG" ] || echo "$pending" | awk -v l="$latest" 'NF && $0 < l {bad=1} END{exit !bad}'; then
  echo "OPRIT: ledger-ul schema_migrations pare desincronizat (prea multe sau migrări mai vechi decât '$latest')."
  echo "Verifică manual ce e aplicat în DB și înregistrează în ledger; nu rula migrări vechi orbește."
  exit 1
fi
for m in $pending; do
  path=$APP/db/migrations/$m.sql
  echo "aplic: $m"
  "${PSQL[@]}" < "$path" > /dev/null
  "${PSQL[@]}" -c "insert into schema_migrations (version) values ('$m') on conflict do nothing" > /dev/null
done

if [ -n "$FLAGS" ]; then
  echo "== 5. flag-uri: $FLAGS =="
  for k in $FLAGS; do
    for key in "$k" "NEXT_PUBLIC_$k"; do
      if grep -q "^$key=" "$ENV_FILE"; then sed -i "s/^$key=.*/$key=1/" "$ENV_FILE"; else printf '%s=1\n' "$key" >> "$ENV_FILE"; fi
    done
  done
fi

echo "== 6. build + recreate =="
cd $APP/infra/hetzner
export BUILD_COMMIT="$COMMIT_LONG"
export BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
export DEPLOYED_AT="$BUILD_TIME"
C=(docker compose -p swypik-prod --env-file .env.production -f docker-compose.prod.yml -f docker-compose.vps.yml -f docker-compose.minio.yml)
docker tag swypik-prod-web-next:latest swypik-prod-web-next:rollback 2>/dev/null || true
"${C[@]}" build web-next 2>&1 | tail -8
"${C[@]}" up -d --no-deps --force-recreate web-next 2>&1 | tail -3

echo "== 7. health (commit nou) =="
sleep 8
for i in $(seq 1 36); do
  body=$(curl -s -m 8 http://127.0.0.1:3005/api/health || true)
  if echo "$body" | grep -q "$COMMIT_LONG"; then echo "OK după $((i*5))s"; break; fi
  sleep 5
  if [ "$i" = 36 ]; then
    echo "HEALTH TIMEOUT — rollback: docker tag swypik-prod-web-next:rollback swypik-prod-web-next:latest && ${C[*]} up -d --no-deps --force-recreate web-next"
    docker logs --tail 40 swypik-prod-web-next-1; exit 1
  fi
done

if [ -n "$EXTRA_SERVICES" ]; then
  echo "== 7b. servicii: $EXTRA_SERVICES =="
  for svc in $EXTRA_SERVICES; do
    case "$svc" in video-worker|cron-worker|platform-api) ;; *) echo "serviciu nepermis: $svc"; exit 2 ;; esac
  done
  "${C[@]}" build $EXTRA_SERVICES 2>&1 | tail -6
  "${C[@]}" up -d --no-deps --force-recreate $EXTRA_SERVICES 2>&1 | tail -6
  sleep 15
  docker ps --format '{{.Names}} {{.Status}}' | grep -E "$(echo $EXTRA_SERVICES | tr ' ' '|')"
fi

echo "== 8. smoke =="
for p in /api/health /ro /en /ro/explore /ro/shop /ro/movies /ro/music /ro/news /ro/gaming; do
  printf '%-14s ' "$p"; curl -s -m 20 -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:3005$p"
done
echo "DEPLOY OK (${COMMIT_LONG:0:8})"
