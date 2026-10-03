#!/usr/bin/env bash
# Swypik PostgreSQL backup.
# Runs on Hetzner and stores compressed dumps under /opt/swypik/backups.
#
# INSTALARE (crontab-ul utilizatorului care rulează stack-ul):
#   15 3 * * * /opt/swypik/app/infra/hetzner/backup-postgres.sh >> /opt/swypik/logs/backup-cron.log 2>&1
#
# ATENȚIE — bitul de execuție (incident 2026-08-02 … 2026-08-17):
#   Fișierul era `100644` în git. Cron îl invocă direct, nu prin `bash`, deci
#   după primul `git pull` care l-a rescris a început să dea
#   `/bin/sh: 1: ...backup-postgres.sh: Permission denied` — 15 zile fără
#   niciun backup, în tăcere. Acum e `100755` în index; nu-l reseta.
#
# EȘECUL TĂCUT era problema reală, nu permisiunea: orice ieșire ≠ 0 (inclusiv
# `Permission denied`, care se întâmplă ÎNAINTE ca scriptul să pornească — vezi
# nota de la `report_failure`) trebuie să producă o alertă vizibilă.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/swypik/app}"
COMPOSE_FILE="${COMPOSE_FILE:-${APP_DIR}/infra/hetzner/docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-${APP_DIR}/infra/hetzner/.env.production}"
BACKUP_DIR="${BACKUP_DIR:-/opt/swypik/backups}"
LOG_FILE="${LOG_FILE:-/opt/swypik/logs/backup.log}"
KEEP_LAST="${KEEP_LAST:-14}"
PG_CONTAINER="${PG_CONTAINER:-swypik-prod-postgres-1}"
MIN_SIZE="${MIN_SIZE:-1048576}"
MIN_TABLES="${MIN_TABLES:-10}"
MIN_MARKETPLACE_PRODUCTS="${MIN_MARKETPLACE_PRODUCTS:-100}"
WEB_URL="${BACKUP_REPORT_URL:-http://localhost:3005}"

mkdir -p "$BACKUP_DIR" "$(dirname "$LOG_FILE")"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

# --- alertare -----------------------------------------------------------------
# Raportăm rezultatul aplicației, care are deja `notifyOps` (dedup + cooldown +
# persistare în `ops_alert_log`). Scriptul nu decide gravitatea, doar transmite
# faptele — aceeași separare ca la `scripts/ops/disk-watch.sh`.
#
# LIMITĂ CUNOSCUTĂ: dacă scriptul nu pornește deloc (bit de execuție lipsă,
# fișier șters), nimic de aici nu rulează. Acel caz e acoperit din partea
# cealaltă, de `/api/cron/backup-report`, care alertează când nu a mai primit
# niciun raport de peste 48h.
report() {
  local status="$1" detail="$2" size="${3:-0}"
  if [[ -z "${CRON_SECRET:-}" && -r "$ENV_FILE" ]]; then
    CRON_SECRET="$(grep -m1 '^CRON_SECRET=' "$ENV_FILE" | cut -d= -f2- | tr -d '"'"'"'')"
  fi
  [[ -n "${CRON_SECRET:-}" ]] || { log "WARN raportarea a fost sărită: CRON_SECRET indisponibil"; return 0; }
  # Timeout-uri mici, intenționat: raportarea e secundară. Dacă aplicația e
  # jos, backup-ul (care deja a reușit) nu are voie să atârne zeci de secunde.
  curl -sS --connect-timeout 5 -m 15 -o /dev/null \
    -X POST \
    -H "x-cron-secret: ${CRON_SECRET}" \
    -H 'content-type: application/json' \
    -d "{\"status\":\"${status}\",\"sizeBytes\":${size},\"detail\":$(printf '%s' "$detail" | sed 's/\\/\\\\/g; s/"/\\"/g; s/^/"/; s/$/"/')}" \
    "${WEB_URL}/api/cron/backup-report" \
    || log "WARN raportarea către ${WEB_URL} a eșuat (backup-ul propriu-zis nu e afectat)"
}

# Orice ieșire pe eroare raportează. `report` nu are voie să reintre în trap.
report_failure() {
  local rc=$?
  trap - ERR EXIT
  [[ $rc -eq 0 ]] && exit 0
  report failed "backup-postgres.sh a ieșit cu codul ${rc}; vezi ${LOG_FILE}"
  exit "$rc"
}
trap report_failure ERR EXIT

if [[ ! -f "$COMPOSE_FILE" ]]; then
  log "ERROR compose file not found: $COMPOSE_FILE"
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  log "ERROR env file not found: $ENV_FILE"
  exit 1
fi

read_env_value() {
  local key="$1"
  local default_value="$2"
  local raw=""
  raw="$(grep -E "^[[:space:]]*${key}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
  raw="${raw%$'\r'}"
  raw="${raw%\"}"
  raw="${raw#\"}"
  raw="${raw%\'}"
  raw="${raw#\'}"
  printf '%s' "${raw:-$default_value}"
}

POSTGRES_USER="${POSTGRES_USER:-$(read_env_value POSTGRES_USER swypik)}"
POSTGRES_DB="${POSTGRES_DB:-$(read_env_value POSTGRES_DB swypik)}"
TIMESTAMP="$(date +%Y-%m-%d_%H-%M-%S)"
BACKUP_FILE="${BACKUP_DIR}/swypik_${POSTGRES_DB}_${TIMESTAMP}.sql.gz"

log "START PostgreSQL backup: database=${POSTGRES_DB} output=${BACKUP_FILE}"

if ! docker ps --format '{{.Names}}' | grep -Fxq "$PG_CONTAINER"; then
  log "ERROR postgres container not running: $PG_CONTAINER"
  exit 1
fi

docker exec -i "$PG_CONTAINER" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" | gzip -9 > "$BACKUP_FILE"

FILE_SIZE="$(stat -c%s "$BACKUP_FILE" 2>/dev/null || echo 0)"
if [[ "$FILE_SIZE" -lt "$MIN_SIZE" ]]; then
  rm -f "$BACKUP_FILE"
  log "ERROR backup file is too small (${FILE_SIZE} bytes < ${MIN_SIZE}); removed suspect dump"
  exit 1
fi

if ! gzip -t "$BACKUP_FILE" 2>/dev/null; then
  rm -f "$BACKUP_FILE"
  log "ERROR backup gzip integrity check failed; removed suspect dump"
  exit 1
fi

TABLES="$(zcat "$BACKUP_FILE" | grep -c '^CREATE TABLE ' || true)"
if [[ "$TABLES" -lt "$MIN_TABLES" ]]; then
  rm -f "$BACKUP_FILE"
  log "ERROR backup has only ${TABLES} tables; removed suspect dump"
  exit 1
fi

MARKETPLACE_ROWS="$(zcat "$BACKUP_FILE" | awk '
  /^COPY public.marketplace_products / { in_copy=1; next }
  in_copy && /^\\\.$/ { in_copy=0; next }
  in_copy { count++ }
  END { print count + 0 }
')"
if [[ "$MARKETPLACE_ROWS" -lt "$MIN_MARKETPLACE_PRODUCTS" ]]; then
  rm -f "$BACKUP_FILE"
  log "ERROR backup has only ${MARKETPLACE_ROWS} marketplace_products rows; removed suspect dump"
  exit 1
fi

find "$BACKUP_DIR" -maxdepth 1 -name "swypik_${POSTGRES_DB}_*.sql.gz" -type f \
  -printf '%T@ %p\n' | sort -rn | awk -v keep="$KEEP_LAST" 'NR > keep {print $2}' | xargs -r rm -f

TOTAL_BACKUPS="$(find "$BACKUP_DIR" -maxdepth 1 -name "swypik_${POSTGRES_DB}_*.sql.gz" -type f | wc -l)"
log "DONE PostgreSQL backup: size=${FILE_SIZE} bytes tables=${TABLES} marketplace_products=${MARKETPLACE_ROWS} retained=${TOTAL_BACKUPS}"
report success "tables=${TABLES} marketplace_products=${MARKETPLACE_ROWS} retained=${TOTAL_BACKUPS}" "$FILE_SIZE"
