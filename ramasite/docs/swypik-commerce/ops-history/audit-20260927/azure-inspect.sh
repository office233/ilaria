#!/usr/bin/env bash
set -euo pipefail
O=(-i /root/.ssh/swypik_admin -o BatchMode=yes -o UserKnownHostsFile=/root/.ssh/azure_known_hosts -o ConnectTimeout=15 -o LogLevel=ERROR)
PJ="ssh ${O[*]} -W %h:%p swypikadmin@4.165.143.236"
for host in 10.60.1.10 10.60.1.11 10.60.2.10 10.60.3.10; do
  echo "NODE $host"
  ssh "${O[@]}" -o ProxyCommand="$PJ" "swypikadmin@$host" 'sudo bash -s' <<'REMOTE'
set -eu
docker ps -a --format '{{.Names}}|{{.Status}}'
systemctl is-active cloudflared-swypik || true
df -h /srv/data | tail -1
if docker ps --format '{{.Names}}' | grep -qx swypik-web-web-next-1; then
  docker exec swypik-web-web-next-1 node -e 'for(const k of ["RESEND_API_KEY","SMTP_HOST","SMTP_USER","SMTP_PASS","EMAIL_FROM","STRIPE_SECRET_KEY","STRIPE_WEBHOOK_SECRET","AZURE_OPENAI_API_KEY","FEATURE_MOVIES","FEATURE_MUSIC","FEATURE_NEWS","FEATURE_GAMING","FEATURE_MESSENGER"]) console.log(k+"="+(process.env[k] ? (k.startsWith("FEATURE_")?process.env[k]:"present"):"absent"))'
fi
if docker ps --format '{{.Names}}' | grep -qx swypik-postgres; then
  docker exec swypik-postgres psql -X -U swypik -d swypik_prod -tAc "select version from schema_migrations order by version"
  systemctl list-timers --all --no-pager | grep -Ei 'backup|swypik' || true
fi
REMOTE
done
