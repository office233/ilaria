#!/usr/bin/env bash
set -euo pipefail
O=(-i /root/.ssh/swypik_admin -o BatchMode=yes -o UserKnownHostsFile=/root/.ssh/azure_known_hosts -o ConnectTimeout=15 -o LogLevel=ERROR)
HOST=${AZURE_TUNNEL_HOST:-swypikadmin@4.165.143.236}
if [ "$HOST" = swypikadmin@10.60.1.11 ]; then
  # Public host key obtained independently through Azure authenticated Run Command.
  install -d -m 700 /root/.ssh
  printf '%s\n' '10.60.1.11 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKmSVOUulpqhGnIoOHYOyvgPqujYsznJUW6Vva+P0DVB' > /root/.ssh/audit_azure_web2_known_hosts
  chmod 600 /root/.ssh/audit_azure_web2_known_hosts
  O=(-i /root/.ssh/swypik_admin -o BatchMode=yes -o UserKnownHostsFile=/root/.ssh/audit_azure_web2_known_hosts -o ConnectTimeout=15 -o LogLevel=ERROR)
  O+=(-o "ProxyCommand=ssh -i /root/.ssh/swypik_admin -o BatchMode=yes -o UserKnownHostsFile=/root/.ssh/azure_known_hosts -W %h:%p swypikadmin@4.165.143.236")
fi
# Preserve the Azure token configuration; a systemd drop-in switches only this connector.
ssh "${O[@]}" "$HOST" 'sudo install -m 640 -o root -g cloudflared /dev/stdin /etc/cloudflared/9d282900-0d36-4bc2-97e0-3b0602e5605d.json' < /etc/cloudflared/9d282900-0d36-4bc2-97e0-3b0602e5605d.json
ssh "${O[@]}" "$HOST" 'sudo install -m 640 -o root -g cloudflared /dev/stdin /etc/cloudflared/public-config.yml' <<'CONFIG'
tunnel: 9d282900-0d36-4bc2-97e0-3b0602e5605d
credentials-file: /etc/cloudflared/9d282900-0d36-4bc2-97e0-3b0602e5605d.json
ingress:
  - hostname: swypik.com
    service: http://127.0.0.1:3005
  - hostname: www.swypik.com
    service: http://127.0.0.1:3005
  - hostname: api.swypik.com
    service: http://127.0.0.1:8090
  - hostname: erp.swypik.com
    service: http://10.60.1.10:8091
  - hostname: "*.erp.swypik.com"
    service: http://10.60.1.10:8091
  - service: http_status:404
CONFIG
ssh "${O[@]}" "$HOST" 'sudo bash -s' <<'REMOTE'
set -euo pipefail
curl -fsS --max-time 10 http://127.0.0.1:3005/api/health >/dev/null
cloudflared --config /etc/cloudflared/public-config.yml tunnel ingress validate
install -d -m 755 /etc/systemd/system/cloudflared-swypik.service.d
cat >/etc/systemd/system/cloudflared-swypik.service.d/public-tunnel.conf <<'UNIT'
[Service]
UnsetEnvironment=TUNNEL_TOKEN
ExecStart=
ExecStart=/usr/bin/cloudflared --no-autoupdate --config /etc/cloudflared/public-config.yml tunnel --metrics 127.0.0.1:20241 --grace-period 30s run
UNIT
systemctl daemon-reload
systemctl restart cloudflared-swypik
systemctl is-active cloudflared-swypik
curl -fsS --max-time 10 http://127.0.0.1:20241/ready
REMOTE
curl -fsS --retry 5 --retry-delay 3 --max-time 20 https://swypik.com/api/health
