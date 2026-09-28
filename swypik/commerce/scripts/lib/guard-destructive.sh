#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Guard pentru scripturi care execută DELETE / DROP / TRUNCATE.
#
# Context (audit 2026-08-15): mai multe scripturi de curățare E2E rulau
# `DELETE FROM ...` direct pe containerul `swypik-prod-postgres-1` — baza de
# PRODUCȚIE — fără `set -e`, fără confirmare și fără dry-run. Filtrele
# (`LIKE 'e2e-test-%'`) erau corecte, dar o singură greșeală de tastare sau un
# `DELETE` eșuat la mijloc (fără `set -e` restul rulau oricum) putea atinge
# date reale de clienți.
#
# Utilizare, la începutul scriptului:
#     source "$(dirname "${BASH_SOURCE[0]}")/../lib/guard-destructive.sh"
#     guard_destructive "cleanup-e2e"
#
# Comportament:
#   - implicit: DRY-RUN. Afișează ce s-ar șterge, nu execută nimic.
#   - execuție reală: CONFIRM_DESTRUCTIVE=yes
#   - în plus, `run_sql` refuză orice instrucțiune distructivă fără WHERE.
# ---------------------------------------------------------------------------

set -euo pipefail

GUARD_DRY_RUN=1

guard_destructive() {
  local script_name="${1:-script}"

  if [[ "${CONFIRM_DESTRUCTIVE:-}" == "yes" ]]; then
    GUARD_DRY_RUN=0
    echo "[$script_name] ⚠  MOD DISTRUCTIV ACTIV — comenzile se execută REAL." >&2
  else
    GUARD_DRY_RUN=1
    echo "[$script_name] DRY-RUN (nu se șterge nimic)." >&2
    echo "[$script_name] Pentru execuție reală: CONFIRM_DESTRUCTIVE=yes $0" >&2
  fi
}

# Rulează o instrucțiune SQL prin comanda psql dată, cu două protecții:
#   1. respectă dry-run-ul;
#   2. refuză DELETE/UPDATE fără WHERE (ștergere oarbă).
#
#   run_sql "<comanda psql>" "<sql>"
run_sql() {
  local psql_cmd="$1"
  local sql="$2"

  if [[ "$sql" =~ ^[[:space:]]*(DELETE|UPDATE) ]] && [[ ! "$sql" =~ [Ww][Hh][Ee][Rr][Ee] ]]; then
    echo "REFUZAT: instrucțiune distructivă fără WHERE → $sql" >&2
    return 1
  fi

  if [[ "$GUARD_DRY_RUN" -eq 1 ]]; then
    echo "  [dry-run] $sql"
    return 0
  fi

  eval "$psql_cmd" -c "$sql"
}
