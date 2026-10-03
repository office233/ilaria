#!/usr/bin/env bash
set -euo pipefail
ssh -i /root/.ssh/swypik_admin -o BatchMode=yes -o UserKnownHostsFile=/root/.ssh/azure_known_hosts -o ConnectTimeout=15 swypikadmin@4.165.143.236 'sudo bash -s' <<'REMOTE'
set -euo pipefail
# Retain the original Azure token tunnel for next.swypik.com while the public
# connector uses the historical tunnel referenced by swypik.com DNS.
sed -e 's/127.0.0.1:20241/127.0.0.1:20242/' -e 's/Description=.*/Description=Swypik preview hostname connector/' /etc/systemd/system/cloudflared-swypik.service > /etc/systemd/system/cloudflared-swypik-preview.service
systemctl daemon-reload
systemctl enable --now cloudflared-swypik-preview
systemctl is-active cloudflared-swypik-preview
curl -fsS http://127.0.0.1:20242/ready
REMOTE
curl -fsS --retry 4 --retry-delay 3 --max-time 15 https://next.swypik.com/api/health
