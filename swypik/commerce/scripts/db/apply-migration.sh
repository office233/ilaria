#!/usr/bin/env bash
# Apply a single SQL migration atomically and record it in schema_migrations.
# Usage: ./scripts/db/apply-migration.sh db/migrations/YYYYMMDD_NNNN_name.sql
#
# Conventions (see DATABASE_CONVENTIONS.md):
#   - Filename: YYYYMMDD_NNNN_short_name.sql
#   - Each migration must be idempotent (use IF NOT EXISTS / DO blocks)
#   - schema_migrations.version stores the filename without .sql extension
#
# Runs inside a single transaction: if SQL fails OR the schema_migrations
# INSERT fails, nothing is committed.

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 <path-to-migration.sql>" >&2
  exit 2
fi

FILE="$1"
if [ ! -f "$FILE" ]; then
  echo "ERROR: file not found: $FILE" >&2
  exit 2
fi

BASENAME=$(basename "$FILE" .sql)
CONTAINER="${POSTGRES_CONTAINER:-swypik-prod-postgres-1}"
DB_USER="${POSTGRES_USER:-swypik}"
DB_NAME="${POSTGRES_DB:-swypik}"

# Check if already applied
ALREADY=$(docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  "SELECT 1 FROM schema_migrations WHERE version = '$BASENAME'" 2>/dev/null || echo "")
if [ "$ALREADY" = "1" ]; then
  echo "SKIP: $BASENAME already in schema_migrations"
  exit 0
fi

echo "Applying: $BASENAME"
# Stream SQL + INSERT into a single transaction
{
  echo "BEGIN;"
  cat "$FILE"
  echo ""
  echo "INSERT INTO schema_migrations (version, applied_at) VALUES ('$BASENAME', NOW()) ON CONFLICT (version) DO NOTHING;"
  echo "COMMIT;"
} | docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1

echo "OK: $BASENAME applied and recorded"
