#!/usr/bin/env bash
# Scrie pe stdout SQL-ul unei migrări împachetat într-o SINGURĂ tranzacție,
# împreună cu rândul din ledger — pentru `... | psql -v ON_ERROR_STOP=1`:
#
#   BEGIN;  <fișierul, fără BEGIN;/COMMIT; proprii>  INSERT schema_migrations;  COMMIT;
#
# Dacă fișierul sau insert-ul eșuează, psql (ON_ERROR_STOP) iese înainte de
# COMMIT → conexiunea se închide → ROLLBACK: nici schema, nici ledger-ul.
#
# Multe migrări vechi au propriul `BEGIN;` ... `COMMIT;` pe linii separate; un
# COMMIT în mijloc ar închide tranzacția noastră înainte de ledger, deci le
# eliminăm (doar liniile care sunt EXACT BEGIN;/COMMIT; — blocurile plpgsql
# folosesc `BEGIN` fără `;`). `CONCURRENTLY` nu poate rula într-o tranzacție:
# asemenea migrări se aplică manual (scripts/db/concurrent-indexes.sql).
#
# Argumente: FIȘIER.sql VERSIUNE
set -euo pipefail

file=$1; version=$2
[ -f "$file" ] || { echo "migration-tx: lipsește $file" >&2; exit 2; }
[[ "$version" =~ ^[0-9]{8}_[0-9A-Za-z_]+$ ]] || { echo "migration-tx: versiune invalidă: $version" >&2; exit 2; }

# CONCURRENTLY în afara comentariilor `--` → refuz explicit.
if sed 's/--.*$//' "$file" | grep -qiE '\bCONCURRENTLY\b'; then
  echo "migration-tx: $version folosește CONCURRENTLY — nu poate rula în tranzacție; aplic-o manual" >&2
  exit 3
fi

printf 'BEGIN;\n'
sed -E '/^[[:space:]]*(BEGIN|COMMIT|START[[:space:]]+TRANSACTION)[[:space:]]*;[[:space:]]*(--.*)?$/Id' "$file"
printf '\nINSERT INTO schema_migrations (version) VALUES (%s) ON CONFLICT DO NOTHING;\n' "'$version'"
printf 'COMMIT;\n'
