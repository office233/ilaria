#!/usr/bin/env bash
# Swypik — deploy multi-nod (Azure acum, Hetzner la nevoie), DOAR din git.
# Rulat ca `dev` pe nodul de control (web-1, primul din WEB_HOSTS):
#   sudo -iu dev bash /opt/swypik/app/infra/azure/deploy.sh [opțiuni]
#
#   --flags "FEATURE_X ..."   FEATURE_X=1 + NEXT_PUBLIC_FEATURE_X=1 în swypik.env
#   --max-migrations N        plafonul de migrări noi (implicit 10; mai mult doar
#                             după ops/migration-dryrun.sh pe o copie a bazei)
#   --services "video-worker cron-worker"   pe lângă web-next + platform-api
#   --video-workers N         replici video-worker per nod worker (1..2, implicit 1)
#   --no-cron                 oprește/nu pornește cron-worker (REPETIȚIA pe copia bazei:
#                             fără emailuri/plăți/joburi reale din copie)
#   --skip-backup             fără dump pre-deploy (DOAR la cutover, imediat după restore)
#
# Pași: lock → clona curată + git pull → env pregătit (flag-uri într-o copie)
#       → preflight → release (git archive) pe noduri → BUILD o dată pe web-1
#       → backup DB (nod data) → migrări O SINGURĂ DATĂ (fiecare fișier + rândul
#       din schema_migrations într-o singură tranzacție) → env instalat pe noduri
#       → rolling web (un nod, health cu commit-ul nou, apoi următorul) → cron +
#       dispatch-worker → worker-e → smoke (cu verdict) → curățenie.
# Ordinea contează: un build eșuat NU mai lasă baza migrată sub codul vechi, iar
# flag-urile nu ajung în swypik.env decât după build + migrări reușite.
# Config: /opt/swypik/env/hosts.env (fără secrete; vezi docs/infra/azure-cutover.md).
# Secretele: /opt/swypik/env/swypik.env (copiat identic pe web + worker).
set -euo pipefail

# Rulează dintr-o copie: `git pull` poate rescrie acest fișier în timpul rulării.
if [ -z "${SWYPIK_DEPLOY_COPY:-}" ]; then
  copy=$(mktemp /tmp/swypik-deploy.XXXXXX)
  cp "$0" "$copy"
  SWYPIK_DEPLOY_COPY="$copy" exec bash "$copy" "$@"
fi
DRAINED=0
# La orice ieșire: șterge copia și reatașează conectorul web-1 dacă l-am drenat pentru build.
trap 'rm -f "$SWYPIK_DEPLOY_COPY" /opt/swypik/state/swypik.env.deploy; if [ "$DRAINED" = 1 ]; then sudo -n systemctl start cloudflared-swypik; fi' EXIT

APP=${SWYPIK_APP:-/opt/swypik/app}
ENV_DIR=${SWYPIK_ENV_DIR:-/opt/swypik/env}
ENV_FILE=$ENV_DIR/swypik.env
STATE_DIR=/opt/swypik/state
REMOTE_REL=/opt/swypik/release

FLAGS=""; MAX_MIG=10; EXTRA=""; VW=1; CRON=1; BACKUP=1
while [ $# -gt 0 ]; do
  case "$1" in
    --flags) FLAGS="$2"; shift 2 ;;
    --max-migrations) MAX_MIG="$2"; shift 2 ;;
    --services) EXTRA="$2"; shift 2 ;;
    --video-workers) VW="$2"; shift 2 ;;
    --no-cron) CRON=0; shift ;;
    --skip-backup) BACKUP=0; shift ;;
    *) echo "argument necunoscut: $1"; exit 2 ;;
  esac
done
for s in $EXTRA; do
  case "$s" in video-worker|cron-worker|platform-api) ;; *) echo "serviciu nepermis: $s"; exit 2 ;; esac
done
has_extra() { [[ " $EXTRA " == *" $1 "* ]]; }

log() { printf '\n== %s ==\n' "$*"; }
die() { echo "OPRIT: $*" >&2; exit 1; }

[ "$(id -un)" = dev ] || die "rulează ca userul dev (sudo -iu dev bash $APP/infra/azure/deploy.sh)"
[ -f "$ENV_DIR/hosts.env" ] || die "lipsește $ENV_DIR/hosts.env"
# shellcheck source=/dev/null
. "$ENV_DIR/hosts.env"   # WEB_HOSTS WORKER_HOSTS DATA_HOST SSH_KEY [REGISTRY_PREFIX PUBLIC_URL]
: "${WEB_HOSTS:?}" "${DATA_HOST:?}"
WORKER_HOSTS=${WORKER_HOSTS:-}; REGISTRY_PREFIX=${REGISTRY_PREFIX:-}; PUBLIC_URL=${PUBLIC_URL:-}
SSH_KEY=${SSH_KEY:-$HOME/.ssh/swypik_deploy}
CONTROL=${WEB_HOSTS%% *}
hostname -I | tr ' ' '\n' | grep -qx "$CONTROL" || die "nodul de control e $CONTROL (primul din WEB_HOSTS), nu acest VM"
SSH=(ssh -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new)

is_local() { [ "$1" = "$CONTROL" ]; }
rel_of() { if is_local "$1"; then echo "$APP"; else echo "$REMOTE_REL"; fi; }
# on HOST SCRIPT ARGS... — rulează un script din release pe nod (argumente fără spații)
on() {
  local h=$1 script=$2; shift 2
  if is_local "$h"; then bash "$APP/$script" "$@"; else "${SSH[@]}" "dev@$h" bash "$REMOTE_REL/$script" "$@"; fi
}
env_get() { # KEY FILE → valoarea (nu se afișează niciodată)
  local v; v=$(grep -E "^$1=" "$2" | tail -1 || true); v=${v#*=}; v=${v%\"}; v=${v#\"}; v=${v%\'}; v=${v#\'}
  printf '%s' "$v"
}

mkdir -p "$STATE_DIR"
exec 9>"$STATE_DIR/deploy.lock"
flock -n 9 || die "alt deploy rulează deja"

log "1. clona de control curată + git pull"
G=(git -C "$APP")
[ -z "$("${G[@]}" status --porcelain --untracked-files=no)" ] || { "${G[@]}" status --short; die "clona $APP are modificări locale — deploy doar din git"; }
"${G[@]}" pull --ff-only origin main | tail -1
COMMIT=$("${G[@]}" rev-parse HEAD)
PREV=$(cat "$STATE_DIR/web.tag" 2>/dev/null || echo -)
echo "HEAD ${COMMIT:0:8} (anterior: ${PREV:0:8})"

# Env-ul acestui deploy: o copie în STATE_DIR (600). swypik.env real e înlocuit
# abia după build + migrări reușite (pasul 7b) — un deploy eșuat nu lasă flag-uri
# pornite pentru imaginea veche.
ENV_NEW="$STATE_DIR/swypik.env.deploy"
( umask 077 && cp "$ENV_FILE" "$ENV_NEW" )
if [ -n "$FLAGS" ]; then
  log "2. flag-uri (în copia de deploy): $FLAGS"
  for k in $FLAGS; do
    [[ "$k" =~ ^FEATURE_[A-Z0-9_]+$ ]] || die "flag invalid: $k"
    for key in "$k" "NEXT_PUBLIC_$k"; do
      if grep -q "^$key=" "$ENV_NEW"; then sed -i "s/^$key=.*/$key=1/" "$ENV_NEW"; else printf '%s=1\n' "$key" >> "$ENV_NEW"; fi
    done
  done
fi

log "3. preflight env"
bash "$APP/infra/azure/preflight.sh" --env "$ENV_NEW" || die "preflight a eșuat"
avail=$(df -BG --output=avail /srv/data | tail -1 | tr -dc '0-9')
[ "$avail" -ge 15 ] || die "doar ${avail}G liberi pe /srv/data (min 15G pentru build)"

log "4. release pe noduri (git archive $COMMIT infra/azure)"
REMOTES=""
for h in $WEB_HOSTS $WORKER_HOSTS $DATA_HOST; do is_local "$h" || [[ " $REMOTES " == *" $h "* ]] || REMOTES="$REMOTES $h"; done
for h in $REMOTES; do
  "${G[@]}" archive --format=tar "$COMMIT" infra/azure | "${SSH[@]}" "dev@$h" \
    "rm -rf $REMOTE_REL.new && mkdir -p $REMOTE_REL.new && tar -x -C $REMOTE_REL.new && rm -rf $REMOTE_REL && mv $REMOTE_REL.new $REMOTE_REL && echo $COMMIT > $REMOTE_REL/COMMIT"
  echo "  $h ok"
done

log "5. build o dată (web-1), ÎNAINTE de backup + migrări"
# Build-ul Next.js ține ~2 vCPU ocupate minute bune: cu >1 nod web, web-1 iese
# din rotația Cloudflare pe durata build-ului (celelalte noduri servesc).
if [ "$(wc -w <<< "$WEB_HOSTS")" -gt 1 ] && sudo -n systemctl is-active cloudflared-swypik >/dev/null 2>&1; then
  sudo -n systemctl stop cloudflared-swypik; DRAINED=1; echo "web-1 drenat pe durata build-ului"
fi
cd "$APP/infra/hetzner"
# prod.yml cere .env.production (env_file); pe Azure e un link spre swypik.env.
[ -e .env.production ] || ln -s "$ENV_FILE" .env.production
BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
export BUILD_COMMIT="$COMMIT" BUILD_TIME DEPLOYED_AT="$BUILD_TIME"
IMAGES="web-next platform-api"
has_extra video-worker && IMAGES="$IMAGES video-worker"
# shellcheck disable=SC2086
if ! docker compose -p swypik-build --env-file "$ENV_NEW" -f docker-compose.prod.yml build $IMAGES > "$STATE_DIR/build.log" 2>&1; then
  tail -40 "$STATE_DIR/build.log"
  die "build eșuat — baza NU a fost atinsă (log: $STATE_DIR/build.log)"
fi
tail -8 "$STATE_DIR/build.log"
for s in $IMAGES; do docker tag "swypik-build-$s:latest" "swypik/$s:$COMMIT"; done
if [ "$DRAINED" = 1 ]; then sudo -n systemctl start cloudflared-swypik; DRAINED=0; fi


if [ "$BACKUP" = 1 ]; then
  log "6. backup DB (nod data)"
  on "$DATA_HOST" infra/azure/node/pre-deploy-dump.sh "$(rel_of "$DATA_HOST")"
else
  log "6. backup SĂRIT (--skip-backup)"
fi

log "7. migrări noi (o singură dată, de pe $CONTROL)"
# Conexiunea prin variabile PG* (nu `-d <url>`): parola nu apare în argv (`ps`).
eval "$(DBURL="$(env_get DATABASE_URL "$ENV_NEW")" python3 "$APP/infra/azure/node/pg-env-from-url.py")"
PSQL=(psql -X -q -v ON_ERROR_STOP=1)
# Protecție (2026-09-25): refuză dacă sunt prea multe migrări sau vreuna e MAI
# VECHE decât ultima aplicată (= ledger desincronizat, nu migrare nouă).
applied=$("${PSQL[@]}" -tAc "select version from schema_migrations" | sort -u)
latest=$(echo "$applied" | tail -1)
pending=$(ls "$APP"/db/migrations/*.sql | xargs -n1 basename | sed 's/\.sql$//' | sort | comm -23 - <(echo "$applied"))
count=$(echo "$pending" | grep -c . || true)
echo "în așteptare: $count (ultima aplicată: $latest)"
[ -n "$pending" ] && echo "$pending"
if [ "$count" -gt "$MAX_MIG" ] || echo "$pending" | awk -v l="$latest" 'NF && $0 < l {bad=1} END{exit !bad}'; then
  die "ledger-ul schema_migrations pare desincronizat (prea multe sau mai vechi decât '$latest')"
fi
for m in $pending; do
  echo "aplic: $m"
  # Fișierul + rândul din ledger într-o SINGURĂ tranzacție (BEGIN/COMMIT proprii
  # ale fișierului sunt eliminate de migration-tx.sh; CONCURRENTLY e refuzat).
  bash "$APP/infra/azure/node/migration-tx.sh" "$APP/db/migrations/$m.sql" "$m" | "${PSQL[@]}" > /dev/null \
    || die "migrarea $m a eșuat — rollback complet, nimic înregistrat; web-ul rulează încă ${PREV:0:8}"
done
unset PGPASSWORD

log "7b. env nou pe noduri (swypik.env)"
for h in $WEB_HOSTS $WORKER_HOSTS; do
  if is_local "$h"; then continue; fi
  "${SSH[@]}" "dev@$h" "umask 077 && cat > $ENV_DIR/swypik.env.new && mv $ENV_DIR/swypik.env.new $ENV_DIR/swypik.env" < "$ENV_NEW"
done
( umask 077 && cp "$ENV_NEW" "$ENV_FILE.new" && mv "$ENV_FILE.new" "$ENV_FILE" )

ship() { # HOST SERVICII...
  local h=$1; shift; local refs=() s
  for s in "$@"; do refs+=("swypik/$s:$COMMIT"); done
  is_local "$h" && return 0
  if [ -n "$REGISTRY_PREFIX" ]; then
    for s in "$@"; do
      "${SSH[@]}" "dev@$h" "docker pull -q $REGISTRY_PREFIX/$s:$COMMIT && docker tag $REGISTRY_PREFIX/$s:$COMMIT swypik/$s:$COMMIT"
    done
  else
    docker save "${refs[@]}" | gzip -1 | "${SSH[@]}" "dev@$h" 'gunzip | docker load -q'
  fi
}
if [ -n "$REGISTRY_PREFIX" ]; then
  for s in $IMAGES; do docker tag "swypik/$s:$COMMIT" "$REGISTRY_PREFIX/$s:$COMMIT"; docker push -q "$REGISTRY_PREFIX/$s:$COMMIT"; done
fi

log "8. rolling web: $WEB_HOSTS"
n_web=$(wc -w <<< "$WEB_HOSTS"); drain=0; [ "$n_web" -gt 1 ] && drain=1
for h in $WEB_HOSTS; do
  echo "-- $h"
  ship "$h" web-next platform-api
  profiles=-
  is_local "$h" && profiles=cron
  on "$h" infra/azure/node/web-up.sh "$COMMIT" "$PREV" "$(rel_of "$h")" "$profiles" "$drain" \
    || die "nodul $h nu a devenit sănătos (revenit la ${PREV:0:8}); nodurile următoare NU au fost atinse"
done
echo "$COMMIT" > "$STATE_DIR/web.tag"

WEB_C=(docker compose -p swypik-web -f "$APP/infra/azure/compose/web.yml" --profile cron)
[ -f "$ENV_DIR/compose.env" ] && WEB_C+=(--env-file "$ENV_DIR/compose.env")
export SWYPIK_IMAGE_PREFIX=swypik SWYPIK_IMAGE_TAG="$COMMIT"
CRON_TAG=${CRON_IMAGE_TAG:-local}
if [ "$CRON" = 0 ]; then
  log "8b. cron-worker + dispatch-worker OPRITE (--no-cron)"
  "${WEB_C[@]}" stop cron-worker dispatch-worker 2>&1 | tail -2 || true
else
  if has_extra cron-worker || ! docker image inspect "swypik/cron-worker:$CRON_TAG" >/dev/null 2>&1; then
    log "8b. cron-worker (build)"
    "${WEB_C[@]}" build cron-worker 2>&1 | tail -3
    "${WEB_C[@]}" up -d --no-deps --force-recreate cron-worker 2>&1 | tail -2
  else
    "${WEB_C[@]}" up -d --no-deps cron-worker 2>&1 | tail -2   # pornește-l dacă lipsește
  fi
  # dispatch-worker rulează imaginea web-next a commit-ului → recreat la fiecare deploy.
  log "8c. dispatch-worker (tick dispecerat 10 s)"
  "${WEB_C[@]}" up -d --no-deps dispatch-worker 2>&1 | tail -2
fi

if has_extra video-worker; then
  log "9. video-worker ($VW/nod): ${WORKER_HOSTS:-niciun nod worker}"
  for h in $WORKER_HOSTS; do
    ship "$h" video-worker
    on "$h" infra/azure/node/worker-up.sh "$COMMIT" "$VW" "$(rel_of "$h")" || die "worker $h nu a pornit"
  done
fi

log "10. smoke (web-1)"
SMOKE_FAIL=0
health=$(curl -fsS -m 20 http://127.0.0.1:3005/api/health || true)
if printf '%s' "$health" | python3 "$APP/infra/azure/node/verify-release-health.py" "$COMMIT"; then
  echo "/api/health    commit OK"
else
  echo "/api/health    FAIL (commit ${COMMIT:0:8} neraportat)"; SMOKE_FAIL=1
fi
# Rute publice care TREBUIE să dea 200 (RO fără prefix; /ro ar da 307).
for p in / /en /explore /shop /en/explore /robots.txt /sitemap.xml; do
  code=$(curl -s -m 20 -o /dev/null -w '%{http_code}' "http://127.0.0.1:3005$p" || echo 000)
  printf '%-14s %s\n' "$p" "$code"
  [ "$code" = 200 ] || SMOKE_FAIL=1
done
# Module după flag: doar informativ (404 când flag-ul e oprit).
for p in /movies /music /news /gaming; do
  printf '%-14s %s (informativ)\n' "$p" "$(curl -s -m 20 -o /dev/null -w '%{http_code}' "http://127.0.0.1:3005$p" || echo 000)"
done
if [ -n "$PUBLIC_URL" ]; then
  printf 'public %-7s ' "health"; curl -s -m 15 "$PUBLIC_URL/api/health" | grep -q "$COMMIT" && echo "commit OK" || echo "commit NEVĂZUT (tunel oprit / cache?)"
fi

log "11. curățenie imagini (păstrez ${COMMIT:0:8} + ${PREV:0:8} + tot ce folosesc containerele)"
for h in $WEB_HOSTS $WORKER_HOSTS; do
  # Imaginile folosite de containere (ex. video-worker, redeployat mai rar decât
  # web-ul) nu se șterg: le excludem explicit și nu mai forțăm `rmi -f`.
  cmd="inuse=\$(docker ps -a --format '{{.Image}}' | sort -u); docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^swypik/(web-next|platform-api|video-worker):' | grep -v -e ':$COMMIT\$' -e ':$PREV\$' | grep -vxF -e \"\$inuse\" | xargs -r docker rmi >/dev/null 2>&1; docker image prune -f >/dev/null"
  if is_local "$h"; then bash -c "$cmd"; else "${SSH[@]}" "dev@$h" "$cmd" || true; fi
done
docker builder prune -f --filter until=168h >/dev/null 2>&1 || true
rm -f "$ENV_NEW"
[ "$SMOKE_FAIL" = 0 ] || die "smoke eșuat pe ${COMMIT:0:8} (release-ul rulează; verifică rutele de mai sus)"
echo "DEPLOY OK (${COMMIT:0:8})"
