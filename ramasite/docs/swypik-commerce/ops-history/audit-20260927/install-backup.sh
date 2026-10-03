#!/usr/bin/env bash
set -euo pipefail
O=(-i /root/.ssh/swypik_admin -o BatchMode=yes -o UserKnownHostsFile=/root/.ssh/azure_known_hosts -o ConnectTimeout=15 -o LogLevel=ERROR)
PJ="ssh ${O[*]} -W %h:%p swypikadmin@4.165.143.236"
D=(ssh "${O[@]}" -o ProxyCommand="$PJ" swypikadmin@10.60.2.10)
"${D[@]}" 'sudo install -m 600 -o root -g root /dev/stdin /etc/swypik-backup.env' < /mnt/e/Swypik/ops/env/r2-backups.env
"${D[@]}" 'sudo install -m 755 -o root -g root /dev/stdin /usr/local/sbin/swypik-backup-r2.sh' < /mnt/e/Swypik/swypik/app/infra/azure/backup-db.sh
"${D[@]}" 'sudo bash -s' <<'REMOTE'
set -euo pipefail
if ! command -v aws >/dev/null; then
  apt-get update -qq >/dev/null
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3-venv >/dev/null
  python3 -m venv /opt/swypik/backup-venv
  /opt/swypik/backup-venv/bin/pip install --disable-pip-version-check -q 'awscli>=1.32,<2'
fi
cat >/usr/local/sbin/swypik-backup-all.sh <<'WRAPPER'
#!/usr/bin/env bash
set -euo pipefail
export PATH="/opt/swypik/backup-venv/bin:$PATH"
set -a
. /etc/swypik-backup.env
set +a
export AWS_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY"
export AWS_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_KEY"
# Initial audit preserves all existing backups; lifecycle retention can be set after review.
export BACKUP_RETENTION_DAYS=0
unset DATABASE_URL
export BACKUP_NAME=swypik
export PG_DUMP_CMD='docker exec swypik-postgres pg_dump -U swypik -d swypik_prod'
/usr/local/sbin/swypik-backup-r2.sh
export BACKUP_NAME=multi-erp
export PG_DUMP_CMD='docker exec multi-erp-postgres pg_dump -U multi -d multi_erp'
/usr/local/sbin/swypik-backup-r2.sh
WRAPPER
chmod 750 /usr/local/sbin/swypik-backup-all.sh
cat >/etc/systemd/system/swypik-db-backup.service <<'UNIT'
[Unit]
Description=Swypik and Multi-ERP PostgreSQL offsite backup to R2
After=network-online.target docker.service
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/swypik-backup-all.sh
UMask=0077
UNIT
cat >/etc/systemd/system/swypik-db-backup.timer <<'UNIT'
[Unit]
Description=Daily offsite PostgreSQL backups
[Timer]
OnCalendar=*-*-* 03:15:00
RandomizedDelaySec=300
Persistent=true
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl start swypik-db-backup.service
systemctl enable --now swypik-db-backup.timer
systemctl show swypik-db-backup.service -p Result -p ExecMainStatus
systemctl list-timers swypik-db-backup.timer --no-pager
REMOTE
