#!/usr/bin/env bash
#
# Backup automat swypik_prod — pg_dump custom format + rotație 7 zile.
# Pattern preluat din multi-erp/docs/backup-strategy.md (regula 3-2-1, nivel 1).
#
# INSTALARE PE VPS (cron, zilnic la 03:30 — după backup-ul Meister de la 03:00):
#   chmod +x /opt/swypik/app/scripts/backup-db.sh
#   crontab -e
#   30 3 * * * /opt/swypik/app/scripts/backup-db.sh >> /var/log/swypik-backup.log 2>&1
#
# Config prin env (sau editează valorile default de mai jos):
#   PGCONTAINER  — numele containerului postgres (default: swypik-postgres)
#   PGUSER       — user postgres (default: swypik)
#   PGDATABASE   — baza de date (default: swypik_prod)
#   BACKUP_DIR   — directorul de backup (default: /opt/swypik/backups)
#   RETENTION_DAYS — câte zile se păstrează dump-urile daily (default: 7)

set -euo pipefail

PGCONTAINER="${PGCONTAINER:-swypik-postgres}"
PGUSER="${PGUSER:-swypik}"
PGDATABASE="${PGDATABASE:-swypik_prod}"
BACKUP_DIR="${BACKUP_DIR:-/opt/swypik/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"

STAMP="$(date +%Y%m%d_%H%M)"
DUMP_FILE="${BACKUP_DIR}/daily_${STAMP}.dump"
TMP_IN_CONTAINER="/tmp/daily_${STAMP}.dump"

mkdir -p "$BACKUP_DIR"

echo "[$(date -Is)] start backup ${PGDATABASE} -> ${DUMP_FILE}"

# 1. Dump în container (custom format, compresie maximă)
docker exec "$PGCONTAINER" pg_dump -U "$PGUSER" -d "$PGDATABASE" \
    -Fc --compress=9 -f "$TMP_IN_CONTAINER"

# 2. Copiază pe host și curăță în container
docker cp "${PGCONTAINER}:${TMP_IN_CONTAINER}" "$DUMP_FILE"
docker exec "$PGCONTAINER" rm -f "$TMP_IN_CONTAINER"

# 3. Verificare integritate: pg_restore --list trebuie să treacă
#    (dump corupt/trunchiat => exit 1, dump-ul stricat se șterge)
if ! docker exec -i "$PGCONTAINER" pg_restore --list < "$DUMP_FILE" > /dev/null 2>&1; then
    echo "[$(date -Is)] EROARE: dump corupt (pg_restore --list a eșuat), șterg ${DUMP_FILE}" >&2
    rm -f "$DUMP_FILE"
    exit 1
fi

# 4. Verificare mărime minimă (protecție împotriva dump-urilor goale)
MIN_BYTES=$((100 * 1024))  # 100 KB
SIZE=$(stat -c%s "$DUMP_FILE" 2>/dev/null || stat -f%z "$DUMP_FILE")
if [ "$SIZE" -lt "$MIN_BYTES" ]; then
    echo "[$(date -Is)] EROARE: dump suspect de mic (${SIZE} bytes), șterg ${DUMP_FILE}" >&2
    rm -f "$DUMP_FILE"
    exit 1
fi

# 5. Rotație: șterge dump-urile daily mai vechi de RETENTION_DAYS zile
find "$BACKUP_DIR" -name 'daily_*.dump' -mtime "+${RETENTION_DAYS}" -delete

echo "[$(date -Is)] backup OK: ${DUMP_FILE} (${SIZE} bytes), retenție ${RETENTION_DAYS} zile"
