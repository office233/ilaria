#!/usr/bin/env bash
# Compare schema_migrations table vs db/migrations directory.
# Exits non-zero if any version in DB has neither a migration file
# nor a baseline stub. Always prints a full report so external auditors
# see exactly which versions are accounted for and which are not.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/swypik/app}"
PG_CONTAINER="${PG_CONTAINER:-swypik-prod-postgres-1}"
PG_USER="${PG_USER:-swypik}"
PG_DB="${PG_DB:-swypik}"

cd "$APP_DIR"

DB_LIST=$(docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -At -c "SELECT version FROM schema_migrations ORDER BY 1")
DISK_LIST=$(ls db/migrations 2>/dev/null | grep -E '\.sql$' | sed -E 's/\.sql$//' | sort -u)
BASELINE_LIST=$(ls db/migrations/baseline 2>/dev/null | grep -E '\.sql$' | sed -E 's/\.applied\.sql$//' | sed -E 's/\.sql$//' | sort -u)

ALL_DISK=$(printf "%s\n%s\n" "$DISK_LIST" "$BASELINE_LIST" | sort -u)

DB_COUNT=$(printf "%s\n" "$DB_LIST" | grep -c . || true)
DISK_COUNT=$(printf "%s\n" "$DISK_LIST" | grep -c . || true)
BASELINE_COUNT=$(printf "%s\n" "$BASELINE_LIST" | grep -c . || true)
ALL_COUNT=$(printf "%s\n" "$ALL_DISK" | grep -c . || true)

MISSING_FILE=$(comm -23 <(printf "%s\n" "$DB_LIST" | sort -u) <(printf "%s\n" "$ALL_DISK"))
MISSING_DB=$(comm -13 <(printf "%s\n" "$DB_LIST" | sort -u) <(printf "%s\n" "$DISK_LIST"))

echo "── Swypik migration audit ──"
echo "  applied in DB         : $DB_COUNT"
echo "  files in db/migrations: $DISK_COUNT"
echo "  baseline stubs        : $BASELINE_COUNT"
echo "  total accounted-for   : $ALL_COUNT"
echo

if [ -n "$MISSING_FILE" ]; then
  echo "DRIFT: versions present in DB but missing as file or baseline stub:"
  printf '  %s\n' $MISSING_FILE
  exit 2
fi
if [ -n "$MISSING_DB" ]; then
  echo "DRIFT: versions present on disk but never applied:"
  printf '  %s\n' $MISSING_DB
  exit 3
fi

echo "OK: 0 drift (every DB version has a file or baseline stub; no unapplied files)."
