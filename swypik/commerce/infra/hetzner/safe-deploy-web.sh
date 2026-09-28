#!/usr/bin/env bash
# Safe atomic deploy for the web-next container with deploy lock,
# release metadata injection, health check, post-deploy probes and rollback.
#
# Pipeline:
#   1. Acquire exclusive flock on /var/lock/swypik-deploy.lock (prevents concurrent deploys).
#   2. Tag current image as :rollback.
#   3. Build new image with BUILD_COMMIT / BUILD_TIME / DEPLOYED_AT injected.
#   4. Recreate container.
#   5. Poll /api/health until 200 AND release.commit matches HEAD (max 90s).
#   6. Post-deploy probes on EXTRA_URLS + optional Playwright health.spec.ts.
#   7. On health failure: restore :rollback tag, recreate container, exit 1.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/swypik/app}"
COMPOSE_FILE="${COMPOSE_FILE:-${APP_DIR}/infra/hetzner/docker-compose.prod.yml}"
COMPOSE_OVERRIDE="${COMPOSE_OVERRIDE:-${APP_DIR}/infra/hetzner/docker-compose.vps.yml}"
ENV_FILE="${ENV_FILE:-${APP_DIR}/infra/hetzner/.env.production}"
SERVICE="${SERVICE:-web-next}"
IMAGE="${IMAGE:-swypik-prod-web-next:latest}"
ROLLBACK_IMAGE="${ROLLBACK_IMAGE:-swypik-prod-web-next:rollback}"
IMAGE_REPO="${IMAGE%:*}"
IMAGE_KEEP="${IMAGE_KEEP:-8}"
HEALTH_URL="${HEALTH_URL:-https://swypik.com/api/health}"
EXTRA_URLS=("${EXTRA_URLS[@]:-https://swypik.com/ https://swypik.com/sitemap.xml}")
EXTRA_PROBE_RETRIES="${EXTRA_PROBE_RETRIES:-3}"
EXTRA_PROBE_TIMEOUT="${EXTRA_PROBE_TIMEOUT:-15}"
LOG_DIR="${LOG_DIR:-/opt/swypik/logs}"
LOCK_FILE="${LOCK_FILE:-/var/lock/swypik-deploy.lock}"
DEPLOYER="${DEPLOYER:-$(whoami 2>/dev/null || echo unknown)@$(hostname 2>/dev/null || echo unknown)}"
mkdir -p "$LOG_DIR"
LOG_FILE="${LOG_DIR}/deploy-web.log"

ts() { date '+%Y-%m-%dT%H:%M:%SZ'; }
log() { local m="[$(ts)] $*"; echo "$m"; echo "$m" >> "$LOG_FILE"; }

# ── Deploy lock (single concurrent deploy) ──
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "ERROR: another deploy is in progress (lock $LOCK_FILE held)" >&2
  log "deploy aborted: lock held by another process"
  exit 2
fi

cd "$APP_DIR"
COMMIT_LONG="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
BUILD_TIME="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
BUILD_TAG_TIME="$(date -u '+%Y%m%dT%H%M%SZ')"
VERSIONED_IMAGE="${VERSIONED_IMAGE:-${IMAGE_REPO}:${COMMIT}-${BUILD_TAG_TIME}}"
log "deploy start commit=$COMMIT deployer=$DEPLOYER service=$SERVICE"

# Fail-fast: dacă git rev-parse nu poate determina commit-ul, refuzăm să facem build
# (bug observat 2026-05-28: empty BUILD_COMMIT a ajuns în BuildKit cache layers
# și a făcut /api/health să răspundă commit=unknown → rollback bucle).
if [ -z "$COMMIT_LONG" ] || [ "$COMMIT_LONG" = "unknown" ]; then
  log "ABORT: BUILD_COMMIT is empty/unknown (git rev-parse failed). Refusing build."
  exit 1
fi

if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker tag "$IMAGE" "$ROLLBACK_IMAGE"
  log "tagged previous image as $ROLLBACK_IMAGE"
fi

export BUILD_COMMIT="$COMMIT_LONG"
export BUILD_TIME="$BUILD_TIME"
export DEPLOYED_AT="$BUILD_TIME"

COMPOSE=(docker compose -f "$COMPOSE_FILE" -f "$COMPOSE_OVERRIDE" --env-file "$ENV_FILE")

# BUILD_NO_CACHE=1 force-rebuild fără cache (recovery dacă cache layers au ENV-uri stale)
BUILD_ARGS=()
if [ "${BUILD_NO_CACHE:-0}" = "1" ]; then
  BUILD_ARGS+=(--no-cache)
  log "BUILD_NO_CACHE=1 → forcing full rebuild without cache"
fi

log "building new image (BUILD_COMMIT=$COMMIT BUILD_TIME=$BUILD_TIME)"
"${COMPOSE[@]}" build "${BUILD_ARGS[@]}" "$SERVICE" >>"$LOG_FILE" 2>&1

docker tag "$IMAGE" "$VERSIONED_IMAGE"
log "tagged new image as $VERSIONED_IMAGE"

if [[ "$IMAGE_KEEP" =~ ^[0-9]+$ ]] && [ "$IMAGE_KEEP" -gt 0 ]; then
  mapfile -t old_images < <(
    docker images "$IMAGE_REPO" --format '{{.Repository}}:{{.Tag}}' \
      | grep -Ev ':(latest|rollback)$' \
      | tail -n +$((IMAGE_KEEP + 1))
  )
  if [ "${#old_images[@]}" -gt 0 ]; then
    docker rmi "${old_images[@]}" >>"$LOG_FILE" 2>&1 || true
    log "removed old versioned images count=${#old_images[@]} keep=$IMAGE_KEEP"
  fi
fi

log "recreating $SERVICE"
"${COMPOSE[@]}" up -d --no-deps "$SERVICE" >>"$LOG_FILE" 2>&1

ok=0
released_commit=""
for i in $(seq 1 30); do
  body=$(curl -sSk -m 5 "$HEALTH_URL" 2>/dev/null || true)
  code=$(curl -sSk -o /dev/null -m 5 -w "%{http_code}" "$HEALTH_URL" 2>/dev/null || echo 000)
  released_commit=$(printf '%s' "$body" | sed -n 's/.*"commit":"\([^"]*\)".*/\1/p' | head -1)
  log "health probe $i: http=$code release.commit=${released_commit:-?}"
  if [ "$code" = "200" ] && [ -n "$released_commit" ] && [ "$released_commit" != "unknown" ]; then
    if [ "${released_commit:0:7}" = "$COMMIT" ] || [ "$released_commit" = "$COMMIT_LONG" ]; then
      ok=1
      break
    fi
  fi
  sleep 3
done

if [ "$ok" -ne 1 ]; then
  log "HEALTH FAILED after 90s (expected commit=$COMMIT, got=${released_commit:-none}). rolling back."
  if docker image inspect "$ROLLBACK_IMAGE" >/dev/null 2>&1; then
    docker tag "$ROLLBACK_IMAGE" "$IMAGE"
    "${COMPOSE[@]}" up -d --no-deps --force-recreate "$SERVICE" >>"$LOG_FILE" 2>&1 || true
    for i in $(seq 1 20); do
      code=$(curl -sSk -o /dev/null -m 5 -w "%{http_code}" "$HEALTH_URL" || echo 000)
      log "rollback probe $i: $code"
      if [ "$code" = "200" ]; then break; fi
      sleep 3
    done
    log "rollback finished"
  else
    log "no rollback image available, aborting"
  fi
  exit 1
fi

post_ok=1
for url in ${EXTRA_URLS[@]}; do
  code=000
  for attempt in $(seq 1 "$EXTRA_PROBE_RETRIES"); do
    code=$(curl -sSk -o /dev/null -m "$EXTRA_PROBE_TIMEOUT" -w "%{http_code}" "$url" || echo 000)
    log "extra probe $url attempt=$attempt/$EXTRA_PROBE_RETRIES: $code"
    if [ "$code" = "200" ]; then
      break
    fi
    sleep 2
  done
  if [ "$code" != "200" ]; then
    log "EXTRA PROBE FAILED at $url ($code)"
    post_ok=0
  fi
done

# Optional post-deploy E2E (skipped if SKIP_POST_E2E=1 or playwright unavailable).
if [ "${SKIP_POST_E2E:-0}" != "1" ] && [ -d "$APP_DIR/tests/e2e" ] && command -v npx >/dev/null 2>&1; then
  log "running post-deploy e2e (health.spec.ts)"
  if ( cd "$APP_DIR" && BASE_URL="https://swypik.com" npx -y playwright test tests/e2e/health.spec.ts --reporter=line >>"$LOG_FILE" 2>&1 ); then
    log "post-deploy e2e PASS"
  else
    log "post-deploy e2e FAIL (kept container running — investigate)"
    post_ok=0
  fi

  # A11y regression smoke (non-blocking by default — opt-in to fail via A11Y_BLOCKING=1).
  if [ -f "$APP_DIR/tests/e2e/a11y.spec.ts" ]; then
    log "running post-deploy a11y smoke (a11y.spec.ts)"
    if ( cd "$APP_DIR" && BASE_URL="https://swypik.com" npx -y playwright test tests/e2e/a11y.spec.ts --reporter=line >>"$LOG_FILE" 2>&1 ); then
      log "post-deploy a11y PASS"
    else
      if [ "${A11Y_BLOCKING:-0}" = "1" ]; then
        log "post-deploy a11y FAIL (A11Y_BLOCKING=1 — marking deploy bad)"
        post_ok=0
      else
        log "post-deploy a11y FAIL (warning only — set A11Y_BLOCKING=1 to enforce)"
      fi
    fi
  fi

  # Forms autocomplete regression (non-blocking; cheap & fast — ~5s)
  if [ -f "$APP_DIR/tests/e2e/forms-autocomplete.spec.ts" ]; then
    log "running post-deploy forms-autocomplete smoke"
    if ( cd "$APP_DIR" && BASE_URL="https://swypik.com" npx -y playwright test tests/e2e/forms-autocomplete.spec.ts --reporter=line >>"$LOG_FILE" 2>&1 ); then
      log "post-deploy forms-autocomplete PASS"
    else
      log "post-deploy forms-autocomplete FAIL (warning only)"
    fi
  fi

  # Perf budget regression (non-blocking; tolerează variance rețea via retries)
  if [ -f "$APP_DIR/tests/e2e/perf.spec.ts" ]; then
    log "running post-deploy perf budget"
    if ( cd "$APP_DIR" && BASE_URL="https://swypik.com" npx -y playwright test tests/e2e/perf.spec.ts --reporter=line >>"$LOG_FILE" 2>&1 ); then
      log "post-deploy perf PASS"
    else
      log "post-deploy perf FAIL (warning only — check budget vs network variance)"
    fi
  fi
fi

log "deploy ok commit=$COMMIT deployer=$DEPLOYER post_ok=$post_ok"
[ "$post_ok" -eq 1 ]
