set -euo pipefail
cd /opt/swypik-chain
echo "== stop + remove chain containers =="
docker compose -p swypik-chain -f docker-compose.yml -f docker-compose.rpc.yml -f docker-compose.blockscout.yml down --remove-orphans 2>&1 | tail -8
docker ps -a --format '{{.Names}}' | grep -iE 'chain|blockscout|bs-postgres' || echo "(no chain containers left)"

echo "== remove rpc/scan from cloudflare tunnel =="
for f in /etc/cloudflared/config.yml /home/dev/.cloudflared/config.yml; do
  cp -a "$f" "$f.bak-$(date +%Y%m%d)"
  python3 - "$f" <<'PY'
import sys,re
p=sys.argv[1]; s=open(p).read()
s=re.sub(r"  - hostname: (rpc|scan)\.swypik\.com\n    service: [^\n]+\n","",s)
open(p,"w").write(s)
PY
  grep -c "rpc.swypik.com\|scan.swypik.com" "$f" || true
done
systemctl restart cloudflared; sleep 5; systemctl is-active cloudflared

echo "== archive /opt/swypik-chain (root-only, NOT deleted) =="
mkdir -p /opt/_arhiva
mv /opt/swypik-chain /opt/_arhiva/swypik-chain-2026-09-25
chown -R root:root /opt/_arhiva/swypik-chain-2026-09-25
chmod 700 /opt/_arhiva /opt/_arhiva/swypik-chain-2026-09-25
ls -ld /opt/_arhiva/swypik-chain-2026-09-25; du -sh /opt/_arhiva/swypik-chain-2026-09-25
