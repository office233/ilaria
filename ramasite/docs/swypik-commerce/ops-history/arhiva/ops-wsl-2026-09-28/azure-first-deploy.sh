#!/usr/bin/env bash
set -uo pipefail
O=(-i /root/.ssh/swypik_admin -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/root/.ssh/azure_known_hosts -o ConnectTimeout=20 -o LogLevel=ERROR -o ServerAliveInterval=30)
ssh "${O[@]}" -o ProxyCommand="ssh ${O[*]} -W %h:%p swypikadmin@4.165.143.236" swypikadmin@10.60.1.10 \
  'sudo -iu dev bash -c "git -C /opt/swypik/app pull -q --ff-only origin main; bash /opt/swypik/app/infra/azure/deploy.sh --no-cron --services video-worker --max-migrations 70 --skip-backup"' 2>&1
echo "DEPLOY_EXIT=$?"
