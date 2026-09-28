#!/usr/bin/env bash
# Rulat PE un nod web (local sau prin SSH) de infra/azure/deploy.sh.
# Recreează web-next + platform-api cu tag-ul dat, așteaptă /api/health cu
# commit-ul nou; la eșec revine singur la tag-ul anterior. Drenează conectorul
# cloudflared al nodului pe durata recreării (dacă e activ și drain=1), ca
# Cloudflare să trimită traficul la celelalte noduri.
#
# Argumente (poziționale, fără spații): TAG PREV_TAG|- RELEASE_DIR PROFILES|- DRAIN(0/1)
set -euo pipefail

tag=$1; prev=$2; rel=$3; profiles=$4; drain=$5
ENV_DIR=${SWYPIK_ENV_DIR:-/opt/swypik/env}

cd "$rel/infra/azure/compose"
C=(docker compose -p swypik-web -f web.yml)
[ -f "$ENV_DIR/compose.env" ] && C+=(--env-file "$ENV_DIR/compose.env")
if [ "$profiles" != "-" ]; then
  IFS=, read -r -a plist <<< "$profiles"
  for p in "${plist[@]}"; do C+=(--profile "$p"); done
fi
export SWYPIK_IMAGE_PREFIX=swypik

docker image inspect "swypik/web-next:$tag" "swypik/platform-api:$tag" >/dev/null \
  || { echo "[$(hostname)] imaginile pentru $tag lipsesc"; exit 1; }

connector_active() { sudo -n systemctl is-active cloudflared-swypik >/dev/null 2>&1; }
was_active=0
if [ "$drain" = 1 ] && connector_active; then
  was_active=1
  echo "[$(hostname)] drenez conectorul cloudflared"
  sudo -n systemctl stop cloudflared-swypik
  sleep 3
fi
reattach() { if [ "$was_active" = 1 ]; then sudo -n systemctl start cloudflared-swypik; fi; }

up_and_wait() { # TAG → 0 dacă /api/health raportează TAG
  local t=$1 i body
  SWYPIK_IMAGE_TAG="$t" "${C[@]}" up -d --no-deps --force-recreate web-next platform-api 2>&1 | tail -3
  for i in $(seq 1 36); do
    if body=$(curl -fsS -m 8 http://127.0.0.1:3005/api/health) &&
       printf '%s' "$body" | python3 "$rel/infra/azure/node/verify-release-health.py" "$t" &&
       curl -fsS -m 8 -o /dev/null http://127.0.0.1:8090/healthz; then
      echo "[$(hostname)] web-next $t OK după $((i * 5))s"
      return 0
    fi
    sleep 5
  done
  return 1
}

if up_and_wait "$tag"; then
  reattach
  exit 0
fi

echo "[$(hostname)] HEALTH TIMEOUT pentru $tag"
docker logs --tail 40 swypik-web-web-next-1 2>&1 || true
if [ "$prev" != "-" ] && docker image inspect "swypik/web-next:$prev" >/dev/null 2>&1; then
  echo "[$(hostname)] rollback la $prev"
  up_and_wait "$prev" || echo "[$(hostname)] ATENȚIE: nici rollback-ul nu raportează sănătos"
fi
reattach
exit 1
