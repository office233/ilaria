#!/usr/bin/env bash
# Rulat PE un nod worker de infra/azure/deploy.sh: pornește video-worker cu
# tag-ul dat și N replici (consumatori ai cozii Redis).
# Argumente: TAG REPLICI RELEASE_DIR
set -euo pipefail

tag=$1; replicas=$2; rel=$3
ENV_DIR=${SWYPIK_ENV_DIR:-/opt/swypik/env}
case "$replicas" in 1|2) ;; *) echo "replici invalide: $replicas (1..2 per nod)"; exit 2 ;; esac

cd "$rel/infra/azure/compose"
C=(docker compose -p swypik-worker -f worker.yml)
[ -f "$ENV_DIR/compose.env" ] && C+=(--env-file "$ENV_DIR/compose.env")

docker image inspect "swypik/video-worker:$tag" >/dev/null \
  || { echo "[$(hostname)] imaginea video-worker:$tag lipsește"; exit 1; }

SWYPIK_IMAGE_PREFIX=swypik SWYPIK_IMAGE_TAG="$tag" \
  "${C[@]}" up -d --force-recreate --scale "video-worker=$replicas" video-worker 2>&1 | tail -4
sleep 20
docker ps --filter "label=com.docker.compose.project=swypik-worker" --format '{{.Names}} {{.Status}}'
running=$(docker ps -q --filter "label=com.docker.compose.project=swypik-worker" --filter status=running | wc -l)
[ "$running" -ge "$replicas" ] || { echo "[$(hostname)] doar $running/$replicas worker-e pornite"; exit 1; }
