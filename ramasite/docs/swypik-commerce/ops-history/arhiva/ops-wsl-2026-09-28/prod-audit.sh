#!/usr/bin/env bash
# Audit READ-ONLY al producției (distro WSL `swypik`). Nu modifică nimic.
# Rulat ca root: wsl -d swypik -u root -- bash /mnt/e/Swypik/ops/prod-audit.sh
APP=/opt/swypik/app
G=(git -c safe.directory=$APP -C $APP)
ENV_FILE=$APP/infra/hetzner/.env.production

echo "== sistem =="; uptime; free -m | head -2; df -h / /opt 2>/dev/null | tail -n +2
echo; echo "== clona live =="
echo "HEAD: $("${G[@]}" rev-parse --short HEAD)  branch: $("${G[@]}" rev-parse --abbrev-ref HEAD)"
"${G[@]}" fetch -q origin 2>/dev/null && echo "în urmă față de origin/main: $("${G[@]}" rev-list --count HEAD..origin/main) commit-uri"
echo "fișiere modificate local (tracked): $("${G[@]}" status --porcelain --untracked-files=no | wc -l)"
"${G[@]}" status --porcelain --untracked-files=no | head -20
echo "fișiere netracked: $("${G[@]}" status --porcelain | grep -c '^??')"
"${G[@]}" status --porcelain | grep '^??' | head -20
echo "stash-uri: $("${G[@]}" stash list | wc -l)"

echo; echo "== containere =="
docker ps -a --format '{{.Names}}\t{{.Status}}\t{{.Image}}' | sort
echo; echo "== containere legate de chain/crypto =="
docker ps -a --format '{{.Names}} {{.Image}}' | grep -iE 'chain|geth|blockscout|bs-|explorer|rpc|swyp' || echo "(niciunul)"
echo; echo "== compose projects =="; docker compose ls 2>/dev/null
echo; echo "== volume docker (chain?) =="; docker volume ls --format '{{.Name}}' | grep -iE 'chain|geth|blockscout|bs' || echo "(niciunul)"
echo; echo "== servicii systemd legate de chain =="; systemctl list-units --all --no-legend 2>/dev/null | grep -iE 'geth|chain|blockscout|swyp' || echo "(niciunul)"
echo; echo "== directoare chain pe disc =="; ls -d /opt/*chain* /opt/*geth* /opt/*blockscout* /root/*chain* /home/*/*chain* 2>/dev/null || echo "(niciunul)"

echo; echo "== chei în .env.production (doar nume, fără valori) =="
[ -f "$ENV_FILE" ] && grep -oE '^[A-Z0-9_]+' "$ENV_FILE" | grep -iE 'SWYP|CHAIN|TREASURY|WALLET_KEY|_PK$|RPC|COINGECKO|CRYPTO|MYSTERY|UNITS' || echo "(niciuna)"
echo "flag-uri:"; grep -E '^(NEXT_PUBLIC_)?FEATURE_' "$ENV_FILE" 2>/dev/null
echo "permisiuni env: $(stat -c '%A %U' "$ENV_FILE" 2>/dev/null)"

echo; echo "== migrări aplicate recent =="
docker exec swypik-prod-postgres-1 psql -U swypik -d swypik_prod -tAc "select version from schema_migrations order by version desc limit 12" 2>&1
echo; echo "== backup-uri =="; ls -lht /opt/swypik/backups 2>/dev/null | head -6; du -sh /opt/swypik/backups 2>/dev/null
echo; echo "== spațiu docker =="; docker system df 2>/dev/null
echo; echo "== health =="; curl -s -m 8 http://127.0.0.1:3005/api/health | head -c 400; echo
echo; echo "== cloudflared =="; systemctl is-active cloudflared
