#!/usr/bin/env bash
set -euo pipefail
O=(-i /root/.ssh/swypik_admin -o BatchMode=yes -o UserKnownHostsFile=/root/.ssh/azure_known_hosts -o ConnectTimeout=15 -o LogLevel=ERROR)
PJ="ssh ${O[*]} -W %h:%p swypikadmin@4.165.143.236"
ssh "${O[@]}" -o ProxyCommand="$PJ" swypikadmin@10.60.2.10 'sudo bash -s' <<'REMOTE'
set -euo pipefail
export PATH="/opt/swypik/backup-venv/bin:$PATH"
set -a
. /etc/swypik-backup.env
set +a
export AWS_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY" AWS_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_KEY" AWS_DEFAULT_REGION=auto
prefix="${BACKUP_S3_PREFIX:-postgres/}"
key=$(aws --endpoint-url "$BACKUP_S3_ENDPOINT" s3api list-objects-v2 --bucket "$BACKUP_S3_BUCKET" --prefix "${prefix%/}/swypik_" --query 'sort_by(Contents, &LastModified)[-1].Key' --output text)
[ -n "$key" ] && [ "$key" != None ]
umask 077
aws --endpoint-url "$BACKUP_S3_ENDPOINT" s3 cp "s3://$BACKUP_S3_BUCKET/$key" /srv/data/backups/audit-offsite.sql.gz --only-show-errors
gzip -t /srv/data/backups/audit-offsite.sql.gz
docker exec swypik-postgres createdb -U swypik swypik_audit_restore_20260927
gzip -dc /srv/data/backups/audit-offsite.sql.gz | docker exec -i swypik-postgres psql -X -v ON_ERROR_STOP=1 -U swypik -d swypik_audit_restore_20260927 > /srv/data/backups/audit-restore-output.txt 2>&1
query='select (select count(*) from users), (select count(*) from schema_migrations), (select count(*) from commerce_orders), (select count(*) from videos)'
source_counts=$(docker exec swypik-postgres psql -X -At -U swypik -d swypik_prod -c "$query")
restore_counts=$(docker exec swypik-postgres psql -X -At -U swypik -d swypik_audit_restore_20260927 -c "$query")
printf 'SOURCE users|migrations|orders|videos %s\nRESTORE %s\n' "$source_counts" "$restore_counts"
[ "$source_counts" = "$restore_counts" ]
sha256sum /srv/data/backups/audit-offsite.sql.gz
# Only this freshly-created disposable verification database is removed.
docker exec swypik-postgres dropdb -U swypik swypik_audit_restore_20260927
echo OFFSITE_RESTORE_VERIFIED
REMOTE
