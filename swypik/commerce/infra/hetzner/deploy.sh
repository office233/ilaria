#!/usr/bin/env bash
# Swypik production deploy script for Hetzner.
# Safe to run repeatedly. It never overwrites a non-git /opt/swypik/app tree.
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/opt/swypik}"
APP_DIR="${APP_DIR:-${DEPLOY_DIR}/app}"
REPO_URL="${REPO_URL:-https://github.com/office233/swypik.git}"
BRANCH="${BRANCH:-main}"
COMPOSE_FILE="${COMPOSE_FILE:-infra/hetzner/docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-infra/hetzner/.env.production}"
LOG_FILE="${LOG_FILE:-${DEPLOY_DIR}/logs/deploy.log}"
MIGRATION_DIR="${MIGRATION_DIR:-db/migrations}"

mkdir -p "${DEPLOY_DIR}/logs"

timestamp() { date '+%Y-%m-%d %H:%M:%S'; }
log() {
  local msg="[$(timestamp)] $*"
  echo "$msg"
  echo "$msg" >> "$LOG_FILE"
}
die() { log "FATAL: $*"; exit 1; }

[[ -d "$APP_DIR" ]] || die "App directory does not exist: $APP_DIR"
cd "$APP_DIR"
[[ -f "$COMPOSE_FILE" ]] || die "Compose file not found: ${APP_DIR}/${COMPOSE_FILE}"
[[ -f "$ENV_FILE" ]] || die "Env file not found: ${APP_DIR}/${ENV_FILE}"

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

: "${POSTGRES_USER:?Missing POSTGRES_USER}"
: "${POSTGRES_DB:?Missing POSTGRES_DB}"

COMPOSE=(docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE")

log "Starting deploy from ${APP_DIR}"

if [[ -d ".git" ]]; then
  log "Updating git checkout: branch=${BRANCH}"
  git fetch origin "$BRANCH"
  git checkout "$BRANCH"
  git pull --ff-only origin "$BRANCH"
  COMMIT_SHA="$(git rev-parse --short HEAD)"
else
  COMMIT_SHA="no-git-$(date +%Y%m%d%H%M%S)"
  log "WARN ${APP_DIR} is not a git checkout; deploying current files without pull."
fi

log "Hardening local infra permissions"
chmod 750 "${APP_DIR}/infra" "${APP_DIR}/infra/hetzner" || true
chmod 640 "${APP_DIR}/infra/hetzner/.env.production" || true
chmod 644 "${APP_DIR}/infra/hetzner/Caddyfile" "${APP_DIR}/infra/hetzner/docker-compose.prod.yml" || true
chmod 755 "${APP_DIR}/infra/hetzner/"*.sh || true

log "Starting database dependencies"
"${COMPOSE[@]}" up -d postgres redis

for i in $(seq 1 60); do
  if "${COMPOSE[@]}" exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
    break
  fi
  [[ "$i" -lt 60 ]] || die "PostgreSQL did not become ready within 60 seconds."
  sleep 1
done

log "Applying idempotent database migrations"
mapfile -t MIGRATIONS < <(find "$MIGRATION_DIR" -maxdepth 1 -type f -name '*.sql' -printf '%f\n' | sort)
[[ "${#MIGRATIONS[@]}" -gt 0 ]] || die "No migrations found in ${MIGRATION_DIR}"
for migration in "${MIGRATIONS[@]}"; do
  log "Applying ${migration}"
  "${COMPOSE[@]}" exec -T postgres \
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
    -f "/docker-entrypoint-initdb.d/${migration}" \
    2>&1 | while IFS= read -r line; do log "  ${line}"; done
done

log "Building production images"
"${COMPOSE[@]}" build --pull web-next platform-api video-worker

log "Starting application stack"
"${COMPOSE[@]}" up -d --remove-orphans

log "Container status"
"${COMPOSE[@]}" ps 2>&1 | while IFS= read -r line; do log "  ${line}"; done

HEALTH_OK=true

if "${COMPOSE[@]}" exec -T web-next \
  node -e "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" \
  >/dev/null 2>&1; then
  log "OK web-next health"
else
  log "ERROR web-next health failed"
  HEALTH_OK=false
fi

# nosemgrep: trailofbits.generic.wget-unencrypted-url.wget-unencrypted-url - container-local healthcheck over loopback.
if "${COMPOSE[@]}" exec -T platform-api wget -qO- http://127.0.0.1:8080/healthz >/dev/null 2>&1; then
  log "OK platform-api health"
else
  log "ERROR platform-api health failed"
  HEALTH_OK=false
fi

if "$HEALTH_OK"; then
  log "Deploy succeeded: ${COMMIT_SHA}"
else
  log "Deploy finished with health check failures: ${COMMIT_SHA}"
  exit 1
fi
