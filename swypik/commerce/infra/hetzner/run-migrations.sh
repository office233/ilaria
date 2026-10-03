#!/bin/bash
# Aplica migrarile SQL pe baza de productie, idempotent.
# - DB corect: swypik_prod (nu "swypik")
# - Tine evidenta migrarilor aplicate in tabelul _applied_migrations
# - Opreste la prima eroare reala (fara "|| echo WARN" care ascunde probleme)
set -euo pipefail

COMPOSE="/opt/swypik/app/infra/hetzner/docker-compose.prod.yml"
MIGRATION_DIR="/opt/swypik/app/db/migrations"
DB_USER="${DB_USER:-swypik}"
DB_NAME="${DB_NAME:-swypik_prod}"

psql_exec() {
  docker compose -f "$COMPOSE" exec -T postgres psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" "$@"
}

mapfile -t MIGRATIONS < <(find "$MIGRATION_DIR" -maxdepth 1 -type f -name '*.sql' -printf '%f\n' | sort)

if [ "${#MIGRATIONS[@]}" -eq 0 ]; then
  echo "No migrations found in $MIGRATION_DIR"
  exit 1
fi

psql_exec -c "CREATE TABLE IF NOT EXISTS _applied_migrations (
  filename text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);"

for m in "${MIGRATIONS[@]}"; do
  already=$(psql_exec -tAc "SELECT 1 FROM _applied_migrations WHERE filename = '$m'")
  if [ "$already" = "1" ]; then
    echo "=== Skipping (already applied): $m ==="
    continue
  fi
  echo "=== Applying: $m ==="
  psql_exec -f "/docker-entrypoint-initdb.d/$m"
  psql_exec -c "INSERT INTO _applied_migrations (filename) VALUES ('$m') ON CONFLICT DO NOTHING;"
  echo ""
done

echo "=== Applied migrations ==="
psql_exec -c "SELECT filename, applied_at FROM _applied_migrations ORDER BY filename;"
