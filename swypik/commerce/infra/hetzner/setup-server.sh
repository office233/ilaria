#!/usr/bin/env bash
set -euo pipefail

echo "=== Step 1: Update system ==="
apt update && apt upgrade -y

echo "=== Step 2: Install Docker ==="
curl -fsSL https://get.docker.com | sh
systemctl enable docker
systemctl start docker

echo "=== Step 3: Install Docker Compose plugin ==="
apt install -y docker-compose-plugin git curl ca-certificates gzip cron

echo "=== Step 4: Verify ==="
docker --version
docker compose version
git --version

echo "=== Step 5: Create app directory ==="
mkdir -p /opt/swypik/app /opt/swypik/backups /opt/swypik/logs
chmod 750 /opt/swypik /opt/swypik/app /opt/swypik/backups /opt/swypik/logs

echo "=== Step 6: Optional backup cron ==="
if [ -x /opt/swypik/app/infra/hetzner/backup-postgres.sh ]; then
  (crontab -l 2>/dev/null | grep -v 'backup-postgres.sh'; echo '0 3 * * * /opt/swypik/app/infra/hetzner/backup-postgres.sh >> /opt/swypik/logs/backup-cron.log 2>&1') | crontab -
  systemctl enable cron
  systemctl start cron
  echo "Backup cron installed: 03:00 daily"
else
  echo "Backup script not found yet; run this again after uploading the app."
fi

echo "=== ALL DONE ==="
