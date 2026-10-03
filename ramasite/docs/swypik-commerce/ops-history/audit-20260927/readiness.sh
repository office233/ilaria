#!/usr/bin/env bash
set -euo pipefail
O=(-i /root/.ssh/swypik_admin -o BatchMode=yes -o UserKnownHostsFile=/root/.ssh/azure_known_hosts -o ConnectTimeout=15 -o LogLevel=ERROR)
PJ="ssh ${O[*]} -W %h:%p swypikadmin@4.165.143.236"
ssh "${O[@]}" swypikadmin@4.165.143.236 'sudo bash -s' <<'WEB'
set -eu
docker exec swypik-web-web-next-1 node -e 'for (const k of ["RESEND_API_KEY","STRIPE_SECRET_KEY","STRIPE_WEBHOOK_SECRET","AZURE_OPENAI_API_KEY","AZURE_OPENAI_CHAT_DEPLOYMENT","AZURE_OPENAI_WHISPER_DEPLOYMENT","AZURE_CONTENT_SAFETY_KEY","CF_REALTIMEKIT_API_TOKEN","CF_REALTIMEKIT_APP_ID","NEXT_PUBLIC_CALLS_ENABLED","VIDEO_QUEUE_BACKEND","FEATURE_STRIPE_CONNECT","FEATURE_EMAIL_MARKETING"]) {const v=process.env[k]||""; console.log(k+"="+(!v?"absent":/placeholder|changeme|your[_-]/i.test(v)?"placeholder":k==="STRIPE_SECRET_KEY"?(v.startsWith("sk_live_")?"live":"test_or_other"):k.startsWith("FEATURE_")||k==="VIDEO_QUEUE_BACKEND"||k==="NEXT_PUBLIC_CALLS_ENABLED"?v:"configured"));}'
docker images --format '{{.Repository}}:{{.Tag}}' | grep -E 'cron|erp' || true
test -d /opt/multi-erp && echo ERP_CLONE_PRESENT || true
systemctl list-timers --all --no-pager | grep -Ei 'swypik|backup' || true
WEB
ssh "${O[@]}" -o ProxyCommand="$PJ" swypikadmin@10.60.2.10 'sudo bash -s' <<'DATA'
set -eu
docker ps --format '{{.Names}}|{{.Status}}'
df -h /srv/data
find /opt/swypik/env -maxdepth 1 -type f -printf '%f\n'
find /srv/data/backups -maxdepth 1 -type f -printf '%f %s bytes\n'
docker exec -i swypik-postgres psql -X -v ON_ERROR_STOP=1 -U swypik -d swypik_prod <<'SQL'
BEGIN READ ONLY;
SELECT count(*) AS migrations, max(version) AS latest FROM schema_migrations;
SELECT count(*) AS users FROM users;
SELECT count(*) AS videos_total, count(*) FILTER (WHERE is_hidden=false) AS visible FROM videos;
SELECT status,count(*) FROM commerce_orders GROUP BY status;
SELECT status,count(*) FROM video_processing_jobs GROUP BY status;
SELECT count(*) AS tables FROM information_schema.tables WHERE table_schema='public';
SELECT count(*) AS cleanup_markers FROM data_cleanup_archive WHERE table_name='_run';
COMMIT;
SQL
docker exec swypik-postgres psql -X -U swypik -d swypik_prod -tAc 'select version from schema_migrations order by version' > /tmp/audit-migrations.txt
echo MIGRATIONS_SHA
sha256sum /tmp/audit-migrations.txt
echo BACKUP_SCHEDULE
systemctl list-timers --all --no-pager | grep -Ei 'swypik|backup' || true
grep -l -E 'swypik|pg_dump|backup-db' /etc/cron.d/* /var/spool/cron/crontabs/* 2>/dev/null || true
DATA
ssh "${O[@]}" -o ProxyCommand="$PJ" swypikadmin@10.60.2.10 'sudo docker exec swypik-postgres psql -X -U swypik -d swypik_prod -tAc "select version from schema_migrations order by version"' > /mnt/e/Swypik/audit-20260927/applied-migrations.txt
WEBVARS=/mnt/e/Swypik/ops/env/r2-backups.env
if [ -f "$WEBVARS" ]; then echo BACKUP_ENV_KEYS; sed -n 's/^\([A-Z_][A-Z_0-9]*\)=.*/\1/p' "$WEBVARS"; fi
