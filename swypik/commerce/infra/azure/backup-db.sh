#!/usr/bin/env bash
# Backup nocturn PostgreSQL → Cloudflare R2 (sau orice S3-compatibil), cu retenție.
#   pg_dump | gzip | aws s3 cp - s3://<bucket>/<prefix><db>_<ts>.sql.gz
# Nimic nu se scrie pe discul local (stream), deci merge pe VM-uri stateless.
# Documentație + cron: docs/infra/r2.md („Backup nocturn al bazei de date”).
#
# Env (obligatorii):
#   DATABASE_URL            conexiunea Postgres (sau PG_DUMP_CMD, vezi mai jos)
#   BACKUP_S3_BUCKET        bucket-ul de backup (separat de media, privat)
#   BACKUP_S3_ENDPOINT      ex. https://<account-id>.r2.cloudflarestorage.com
#   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY   token R2 limitat la bucket-ul de backup
# Env (opționale):
#   BACKUP_S3_PREFIX        implicit "postgres/"
#   BACKUP_RETENTION_DAYS   implicit 14; 0 = fără ștergere din script (regulă lifecycle R2)
#   BACKUP_NAME             implicit "swypik"
#   PG_DUMP_CMD             implicit "pg_dump"; ex. "docker exec swypik-postgres pg_dump -U swypik -d swypik_prod"
#   POSTGRES_CONTAINER      dacă PG_DUMP_CMD lipsește: pg_dump rulează în acest container
#                           (cu POSTGRES_USER / POSTGRES_DB, implicit swypik / swypik_prod)
#   AWS_REGION              implicit "auto" (R2)
#   LOCK_FILE               implicit /opt/swypik/backup.lock (același ca în backup.env pe nodul data)
#   LOCK_WAIT_SECONDS       implicit 0 = dacă rulează alt backup, ieși 0 (cron nocturn);
#                           >0 = așteaptă lock-ul, apoi EȘUEAZĂ (pre-deploy: fără backup, fără migrări)
#   BACKUP_REASON           ex. "pre-deploy" — intră în numele obiectului
#   BACKUP_ENV_FILE         implicit /opt/swypik/env/backup.env — încărcat automat dacă
#                           BACKUP_S3_BUCKET nu e deja în mediu (cron/systemd fără `set -a`)
# Argumente: --dry-run  (doar afișează ce ar face)
set -euo pipefail

# aws-cli e instalat ca snap pe nodul data: /snap/bin lipsește din PATH-ul
# sesiunilor non-interactive (ssh din deploy.sh, cron, systemd).
export PATH="$PATH:/snap/bin:/usr/local/bin"

BACKUP_ENV_FILE="${BACKUP_ENV_FILE:-/opt/swypik/env/backup.env}"
if [ -z "${BACKUP_S3_BUCKET:-}" ] && [ -r "$BACKUP_ENV_FILE" ]; then
  set -a
  # shellcheck source=/dev/null
  . "$BACKUP_ENV_FILE"
  set +a
fi

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"; }
fail() { log "ERROR: $*"; exit 1; }

: "${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET lipsește}"
: "${BACKUP_S3_ENDPOINT:?BACKUP_S3_ENDPOINT lipsește}"
PREFIX="${BACKUP_S3_PREFIX:-postgres/}"
PREFIX="${PREFIX%/}/"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
NAME="${BACKUP_NAME:-swypik}"
if [ -z "${PG_DUMP_CMD:-}" ] && [ -n "${POSTGRES_CONTAINER:-}" ]; then
  PG_DUMP_CMD="docker exec ${POSTGRES_CONTAINER} pg_dump -U ${POSTGRES_USER:-swypik} -d ${POSTGRES_DB:-swypik_prod}"
fi
PG_DUMP_CMD="${PG_DUMP_CMD:-pg_dump}"
LOCK_FILE="${LOCK_FILE:-/opt/swypik/backup.lock}"
LOCK_WAIT_SECONDS="${LOCK_WAIT_SECONDS:-0}"
REASON="${BACKUP_REASON:-}"
[[ -z "$REASON" || "$REASON" =~ ^[a-z0-9-]+$ ]] || { echo "BACKUP_REASON invalid: $REASON" >&2; exit 1; }
export AWS_REGION="${AWS_REGION:-auto}"
# aws-cli v2 recent calculează implicit checksum-uri CRC la upload în flux;
# R2 le acceptă doar pe unele operații — le cerem doar când sunt obligatorii.
export AWS_REQUEST_CHECKSUM_CALCULATION="${AWS_REQUEST_CHECKSUM_CALCULATION:-when_required}"
export AWS_RESPONSE_CHECKSUM_VALIDATION="${AWS_RESPONSE_CHECKSUM_VALIDATION:-when_required}"

[[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] || fail "BACKUP_RETENTION_DAYS trebuie să fie un număr"
[[ "$LOCK_WAIT_SECONDS" =~ ^[0-9]+$ ]] || fail "LOCK_WAIT_SECONDS trebuie să fie un număr"
command -v aws >/dev/null || fail "aws-cli lipsește (https://docs.aws.amazon.com/cli/)"
command -v gzip >/dev/null || fail "gzip lipsește"

s3() { aws --endpoint-url "$BACKUP_S3_ENDPOINT" "$@"; }

exec 9>"$LOCK_FILE"
if [ "$LOCK_WAIT_SECONDS" -gt 0 ]; then
  # Pre-deploy: un backup care rulează deja NU e un backup al stării de acum.
  flock -w "$LOCK_WAIT_SECONDS" 9 || fail "lock-ul $LOCK_FILE e ținut de ${LOCK_WAIT_SECONDS}s — niciun backup nou"
elif ! flock -n 9; then
  log "backup sărit: rulează deja altul"
  exit 0
fi

ts="$(date -u '+%Y%m%dT%H%M%SZ')"
key="${PREFIX}${NAME}_${ts}${REASON:+_$REASON}.sql.gz"
target="s3://${BACKUP_S3_BUCKET}/${key}"

# Argumentele de conexiune: DATABASE_URL dacă există; altfel PG_DUMP_CMD își
# ia singur conexiunea (ex. în container, cu POSTGRES_USER/POSTGRES_DB).
dump_args=(--no-owner --no-privileges --format=plain)
if [ -n "${DATABASE_URL:-}" ]; then
  dump_args+=(--dbname="$DATABASE_URL")
fi

if [ "$DRY_RUN" = 1 ]; then
  log "dry-run: ${PG_DUMP_CMD} ${dump_args[*]/--dbname=*/--dbname=***} | gzip -9 | aws s3 cp - ${target}"
else
  log "backup start → ${target}"
  # shellcheck disable=SC2086  # PG_DUMP_CMD poate conține mai multe cuvinte (docker exec …)
  $PG_DUMP_CMD "${dump_args[@]}" | gzip -9 | s3 s3 cp - "$target" --only-show-errors
  size="$(s3 s3api head-object --bucket "$BACKUP_S3_BUCKET" --key "$key" --query ContentLength --output text)"
  [ "${size:-0}" -gt 100 ] 2>/dev/null || fail "obiectul încărcat e gol sau lipsește (${size:-?} bytes)"
  log "backup ok ${target} (${size} bytes)"
fi

if [ "$RETENTION_DAYS" -gt 0 ]; then
  cutoff="$(date -u -d "-${RETENTION_DAYS} days" '+%Y-%m-%dT%H:%M:%SZ')"
  old_keys="$(s3 s3api list-objects-v2 --bucket "$BACKUP_S3_BUCKET" --prefix "${PREFIX}${NAME}_" \
    --query "Contents[?LastModified<'${cutoff}'].Key" --output text)"
  for old in $old_keys; do
    [ "$old" = "None" ] && continue
    if [ "$DRY_RUN" = 1 ]; then
      log "dry-run: ar șterge s3://${BACKUP_S3_BUCKET}/${old} (mai vechi de ${RETENTION_DAYS} zile)"
    else
      s3 s3 rm "s3://${BACKUP_S3_BUCKET}/${old}" --only-show-errors
      log "retenție: șters ${old}"
    fi
  done
fi
