#!/usr/bin/env bash
#
# check-schema-drift.sh — compară schema din PRODUCȚIE cu `db/schema.sql`.
#
# DE CE EXISTĂ: `db/schema.sql` a rămas ~4 luni în urmă (îi lipseau 69 de
# tabele, printre care TOT subsistemul SWYP) și a indus în eroare două
# audituri consecutive — analiza statică pe schema versionată a raportat
# coloane inexistente și a ratat coloane reale. Sursa de adevăr e `pg_dump`;
# fișierul versionat e doar o oglindă care trebuie ținută sincronizată.
#
# READ-ONLY pe producție: rulează exclusiv `pg_dump --schema-only`.
#
# UTILIZARE:
#   bash scripts/db/check-schema-drift.sh            # verifică (exit 1 la drift)
#   bash scripts/db/check-schema-drift.sh --write    # regenerează db/schema.sql
#
# EXIT CODES:
#   0 = sincronizat   1 = drift detectat   2 = eroare de rulare
#
# NOTĂ CI: NU e legat de CI, pentru că runner-ul nu are acces la baza de
# producție. Se rulează manual, de pe o mașină cu acces (ex. WSL `swypik`),
# după fiecare set de migrații aplicate.

set -uo pipefail

CONTAINER="${PG_CONTAINER:-swypik-prod-postgres-1}"
DB_USER="${PG_USER:-swypik}"
DB_NAME="${PG_DB:-swypik_prod}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SCHEMA_FILE="$REPO_ROOT/db/schema.sql"

WRITE=0
[[ "${1:-}" == "--write" ]] && WRITE=1

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    echo "EROARE: containerul '$CONTAINER' nu rulează." >&2
    echo "Setează PG_CONTAINER dacă folosește alt nume." >&2
    exit 2
fi

TMP="$(mktemp)"
trap 'rm -f "$TMP" "$TMP.norm" "$SCHEMA_FILE.norm"' EXIT

# --- generare ---------------------------------------------------------------
if ! docker exec "$CONTAINER" pg_dump \
        --schema-only --no-owner --no-privileges --no-comments \
        -U "$DB_USER" "$DB_NAME" > "$TMP" 2>/dev/null; then
    echo "EROARE: pg_dump a eșuat." >&2
    exit 2
fi

# --- normalizare ------------------------------------------------------------
# Eliminăm ce diferă între rulări fără să reflecte o schimbare reală de schemă:
#   \restrict / \unrestrict  → token aleator generat la fiecare pg_dump
#   "Dumped by/from"         → versiunea binarului și a serverului
#   linii goale consecutive  → colapsate (cat -s)
normalize() {
    grep -vE '^\\(un)?restrict ' "$1" \
      | grep -vE '^-- Dumped (from|by) ' \
      | cat -s
}

normalize "$TMP" > "$TMP.norm"

if [[ $WRITE -eq 1 ]]; then
    cp "$TMP.norm" "$SCHEMA_FILE"
    echo "db/schema.sql regenerat din $DB_NAME."
    echo "  tabele:   $(grep -cE '^CREATE TABLE' "$SCHEMA_FILE")"
    echo "  indexuri: $(grep -cE '^CREATE (UNIQUE )?INDEX' "$SCHEMA_FILE")"
    echo "Verifică diff-ul înainte de commit: git diff --stat db/schema.sql"
    exit 0
fi

if [[ ! -f "$SCHEMA_FILE" ]]; then
    echo "EROARE: $SCHEMA_FILE nu există. Rulează cu --write." >&2
    exit 2
fi

normalize "$SCHEMA_FILE" > "$SCHEMA_FILE.norm"

if diff -q "$SCHEMA_FILE.norm" "$TMP.norm" >/dev/null; then
    echo "OK: db/schema.sql e sincronizat cu $DB_NAME."
    exit 0
fi

echo "DRIFT DETECTAT între producție și db/schema.sql"
echo

# Rezumat pe obiecte: mai util decât un diff linie-cu-linie de 12k linii.
objects() {
    grep -oE '^CREATE (TABLE|UNIQUE INDEX|INDEX|VIEW|MATERIALIZED VIEW) [A-Za-z0-9_."]+' "$1" \
      | sed -E 's/public\.//g; s/"//g; s/CREATE UNIQUE INDEX/CREATE INDEX/' \
      | sort -u
}
objects "$TMP.norm"        > "$TMP.prod"
objects "$SCHEMA_FILE.norm" > "$TMP.repo"

echo "--- în PRODUCȚIE, lipsă în db/schema.sql ---"
comm -23 "$TMP.prod" "$TMP.repo" || true
echo
echo "--- în db/schema.sql, lipsă în PRODUCȚIE ---"
comm -13 "$TMP.prod" "$TMP.repo" || true
echo
echo "linii: prod=$(wc -l < "$TMP.norm")  repo=$(wc -l < "$SCHEMA_FILE.norm")"
echo
echo "Pentru sincronizare: bash scripts/db/check-schema-drift.sh --write"
rm -f "$TMP.prod" "$TMP.repo"
exit 1
