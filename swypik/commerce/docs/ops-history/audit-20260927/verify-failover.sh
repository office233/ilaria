#!/usr/bin/env bash
set -euo pipefail
S=(ssh -i /root/.ssh/swypik_admin -o BatchMode=yes -o UserKnownHostsFile=/root/.ssh/azure_known_hosts -o ConnectTimeout=15 swypikadmin@4.165.143.236)
restore() { "${S[@]}" 'sudo systemctl start cloudflared-swypik'; }
trap restore EXIT
"${S[@]}" 'sudo systemctl stop cloudflared-swypik'
echo WEB1_CONNECTOR_STOPPED
curl -fsS --retry 3 --retry-delay 2 --max-time 15 https://swypik.com/api/health
echo
restore
trap - EXIT
"${S[@]}" 'sudo systemctl is-active cloudflared-swypik; curl -fsS http://127.0.0.1:20241/ready'
