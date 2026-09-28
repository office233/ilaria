echo "== /opt/swypik-chain =="; ls -la /opt/swypik-chain; du -sh /opt/swypik-chain 2>/dev/null
echo "== secret-looking files (names only) =="; find /opt/swypik-chain -maxdepth 3 \( -iname '*key*' -o -iname '*.env*' -o -iname 'password*' -o -iname '*keystore*' -o -iname 'nodekey' \) 2>/dev/null | head -20
echo "== cloudflared ingress =="; for f in /etc/cloudflared/config.yml /root/.cloudflared/config.yml /home/*/.cloudflared/config.yml; do [ -f "$f" ] && { echo "--- $f"; grep -vE 'credentials|token' "$f"; }; done
echo "== web-next env keys mentioning chain (names only) =="; docker exec swypik-prod-web-next-1 sh -c 'env | cut -d= -f1' | grep -iE 'SWYP|CHAIN|RPC|TREASURY|WALLET|EXPLORER' || echo none
echo "== other env files with chain keys (names only) =="; grep -lE '^(SWYP_|CHAIN_|TREASURY)' /opt/swypik/app/infra/hetzner/.env* /opt/swypik/*.env /opt/swypik-chain/.env* 2>/dev/null
echo "== top cpu =="; docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}' | sort -k2 -r | head -8
