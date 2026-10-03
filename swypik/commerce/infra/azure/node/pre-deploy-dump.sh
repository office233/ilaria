#!/usr/bin/env bash
# Rulat PE nodul data (ca `dev`, prin SSH din deploy.sh) înainte de migrări.
# Cu backup.env + aws-cli: backup complet off-site (infra/azure/backup-db.sh).
# Altfel: pg_dump local pe discul de date. Orice eșec oprește deploy-ul
# (fără backup nu se aplică migrări).
# Argumente: RELEASE_DIR
set -euo pipefail

rel=$1
# aws-cli e snap pe nodul data; /snap/bin nu e în PATH-ul sesiunilor SSH non-interactive.
export PATH="$PATH:/snap/bin:/usr/local/bin"

# Configurația de pe nodul data (600, owner dev): BACKUP_S3_*, AWS_*, PG_DUMP_CMD,
# LOCK_FILE=/opt/swypik/backup.lock (același lock ca backup-ul nocturn).
BACKUP_ENV=${BACKUP_ENV_FILE:-/opt/swypik/env/backup.env}
if [ -r "$BACKUP_ENV" ]; then set -a; . "$BACKUP_ENV"; set +a; fi

PG_CONTAINER=${POSTGRES_CONTAINER:-swypik-postgres}
dir=${BACKUP_LOCAL_DIR:-/srv/data/backups}
stamp=$(date +%Y%m%d-%H%M)

if [ -f "$rel/infra/azure/backup-db.sh" ] && [ -n "${BACKUP_S3_BUCKET:-}" ] && command -v aws >/dev/null; then
  # PG_DUMP_CMD din backup.env are prioritate; altfel backup-db.sh folosește containerul.
  # LOCK_WAIT_SECONDS: dacă rulează backup-ul nocturn, îl așteptăm, apoi facem unul NOU.
  POSTGRES_CONTAINER="$PG_CONTAINER" BACKUP_REASON=pre-deploy LOCK_WAIT_SECONDS=${LOCK_WAIT_SECONDS:-900} \
    bash "$rel/infra/azure/backup-db.sh"
  exit 0
fi

echo "backup off-site neconfigurat (backup.env/aws-cli) — dump local în $dir/postgres"
# /srv/data/backups a fost creat de cloud-init ca root:root 750 — `dev` nu poate
# scrie acolo. cloud-init îl creează acum dev:dev; pe nodurile vechi îl reparăm
# (sudo -n, fără parolă) sau oprim deploy-ul cu instrucțiunea exactă.
if ! { mkdir -p "$dir/postgres" 2>/dev/null && [ -w "$dir/postgres" ]; }; then
  sudo -n install -d -o "$(id -un)" -g "$(id -gn)" -m 750 "$dir" "$dir/postgres" 2>/dev/null \
    || { echo "OPRIT: $dir/postgres nu e scriibil de $(id -un); rulează: sudo chown -R dev:dev $dir" >&2; exit 1; }
fi

f="$dir/postgres/pre-deploy-$stamp.sql.gz"
docker exec "$PG_CONTAINER" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges' \
  | gzip -1 > "$f.tmp"
gzip -t "$f.tmp"
test -s "$f.tmp"
mv "$f.tmp" "$f"
chmod 600 "$f"
ls -lh "$f"

# Păstrează ultimele 10 dump-uri pre-deploy locale (backup-ul zilnic are retenția lui).
find "$dir/postgres" -maxdepth 1 -name 'pre-deploy-*.sql.gz' -printf '%T@ %p\n' 2>/dev/null \
  | sort -rn | tail -n +11 | cut -d' ' -f2- | xargs -r rm -f
