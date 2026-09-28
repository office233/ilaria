#!/usr/bin/env bash
set -euo pipefail
J=swypikadmin@4.165.143.236
O=(-i /root/.ssh/swypik_admin -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/root/.ssh/azure_known_hosts -o ConnectTimeout=20 -o LogLevel=ERROR)
ssh "${O[@]}" -o ProxyCommand="ssh ${O[*]} -W %h:%p $J" swypikadmin@10.60.1.10 'sudo -iu dev bash -s' <<'REMOTE'
set -euo pipefail
K=(-i /home/dev/.ssh/swypik_deploy -o LogLevel=ERROR)
git -C /opt/swypik/app pull -q --ff-only origin main && git -C /opt/swypik/app log --oneline -1
git -C /opt/swypik/app archive HEAD infra/azure | ssh "${K[@]}" dev@10.60.2.10 'rm -rf /opt/swypik/release && mkdir -p /opt/swypik/release && tar -x -C /opt/swypik/release'
ssh "${K[@]}" dev@10.60.2.10 'cd /opt/swypik/release && docker compose -p swypik-data -f infra/azure/compose/data.yml --env-file /opt/swypik/env/data.env up -d 2>&1 | tail -5; sleep 20; docker ps --format "{{.Names}} {{.Status}}"'
REMOTE
