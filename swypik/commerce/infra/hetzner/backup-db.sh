#!/usr/bin/env bash
# Nightly PostgreSQL backup for Swypik production.
set -euo pipefail

CONTAINER="${POSTGRES_CONTAINER:-swypik-prod-postgres-1}"
DB_NAME="${POSTGRES_DB:-swypik}"
DB_USER="${POSTGRES_USER:-swypik}"
BACKUP_DIR="${BACKUP_DIR:-/opt/swypik/backups/postgres}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
LOCK_FILE="${LOCK_FILE:-/var/lock/swypik-db-backup.lock}"

mkdir -p "$BACKUP_DIR"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] backup skipped: another backup is running"
  exit 0
fi

ts="$(date -u '+%Y%m%dT%H%M%SZ')"
target="${BACKUP_DIR}/${DB_NAME}_${ts}.sql.gz"
tmp="${target}.tmp"

cleanup() {
  rm -f "$tmp"
}
trap cleanup EXIT

echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] backup start db=${DB_NAME} container=${CONTAINER} target=${target}"

docker exec "$CONTAINER" pg_dump \
  -U "$DB_USER" \
  -d "$DB_NAME" \
  --no-owner \
  --no-privileges \
  --format=plain \
  | gzip -9 > "$tmp"

gzip -t "$tmp"
test -s "$tmp"
mv "$tmp" "$target"
chmod 600 "$target"

if [[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] && [ "$RETENTION_DAYS" -gt 0 ]; then
  find "$BACKUP_DIR" -type f -name "${DB_NAME}_*.sql.gz" -mtime +"$RETENTION_DAYS" -print -delete
fi

size="$(du -h "$target" | awk '{print $1}')"
echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] backup ok target=${target} size=${size} retention_days=${RETENTION_DAYS}"
