#!/usr/bin/env bash
# Backup rapid al bazei swypik_prod inainte de deploy.
# Rulare pe VPS: bash /tmp/backup-prod.sh
set -euo pipefail

CONTAINER="${CONTAINER:-swypik-prod-postgres-1}"
OUT_DIR="${OUT_DIR:-/opt/meister-backups}"
TS="$(date +%Y%m%d_%H%M)"
OUT="${OUT_DIR}/swypik_pre_deploy_${TS}.sql.gz"

mkdir -p "$OUT_DIR"
docker exec "$CONTAINER" sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip > "$OUT"

SIZE=$(stat -c %s "$OUT")
if [ "$SIZE" -lt 20000 ]; then
    echo "EROARE: backup suspect de mic (${SIZE} bytes)" >&2
    exit 1
fi
echo "OK: $OUT ($(du -h "$OUT" | cut -f1))"
