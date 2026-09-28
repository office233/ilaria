# Release 2026-09-21 — curățenie post-Antigravity + Swypik Movies

Ce conține `main` (31 commit-uri peste ultimul deploy):

1. Curățenie (branch `fix/agy-cleanup`): normalizare CRLF→LF, migrări lipsă pentru
   Seller ERP (`20260921_0001`), Mystery Drop server-side (`20260921_0002`),
   eliminarea funcționalităților false (AWB random, șoferi simulați, checkout fals,
   „AI Integrity Shield", telemetrie inventată, scripturi de build fictive),
   Squad Buy și catalogul viral după flag (OFF), logger structurat, i18n.
2. Swypik Movies (branch `feat/movies`): migrările `20260921_0003_movies.sql` și
   `20260921_0004_movies_visibility_guard.sql`, `20260921_0005_movies_watchlist.sql` (Lista mea), API, pagini în stil Netflix, studio, admin, feed.

> **Corecție 2026-09-22:** nu există VPS. Hosting-ul e distro-ul WSL2 `swypik` de pe PC-ul local (`wsl -d swypik -u root`), clona live `/opt/swypik/app`, compose `prod.yml + vps.yml + minio.yml`, fără Caddy (tunel Cloudflare → `localhost:3005`). Pașii de mai jos se rulează în distro, nu prin ssh; procedura reală e în `CLAUDE.md` → Workflow și în `E:\Swypik\deploy-step-*.sh`. Movies a fost lansat împreună cu Music pe 2026-09-22.

## Pe VPS (`root@46.224.197.2`, `/opt/swypik/app`) — ISTORIC, vezi corecția de mai sus

```bash
cd /opt/swypik/app

# 1. Backup DB înainte de migrări (regula 4 din CLAUDE.md)
docker exec swypik-prod-postgres-1 sh -c 'pg_dump -U $POSTGRES_USER $POSTGRES_DB' \
  | gzip > /opt/swypik/backups/pre-movies-$(date +%Y%m%d-%H%M).sql.gz

# 2. Flag-urile Movies în env (NEXT_PUBLIC_* se inlinează la build, deci ÎNAINTE de build)
grep -qE '^FEATURE_MOVIES=' infra/hetzner/.env.production || cat >> infra/hetzner/.env.production <<'EOF'
FEATURE_MOVIES=1
NEXT_PUBLIC_FEATURE_MOVIES=1
EOF
# Obligatoriu pentru token-urile de stream (există deja pentru sesiunile anonime):
grep -q '^APP_ENCRYPTION_KEY=' infra/hetzner/.env.production || echo "LIPSEȘTE APP_ENCRYPTION_KEY"

# 3. Deploy (pull main, aplică TOATE migrările idempotent, rebuild, restart, health check)
bash infra/hetzner/deploy.sh

# 4. Smoke test
curl -s -o /dev/null -w '%{http_code}\n' https://swypik.com/api/health          # 200
curl -s https://swypik.com/api/movies | head -c 200; echo                        # {"items":[],...}
curl -s -o /dev/null -w '%{http_code}\n' https://swypik.com/movies              # 200
curl -s -o /dev/null -w '%{http_code}\n' https://swypik.com/api/explore/feed    # 200 (feed-ul cu JOIN-ul Movies)
```

Dacă `deploy.sh` nu aplică migrările (rulează-le manual, în ordine):

```bash
for f in db/migrations/20260921_000{1,2,3,4,5}_*.sql; do ./scripts/db/apply-migration.sh "$f"; done
```

## După deploy

1. `/admin/movies` → „Aprobă publisher" cu ID-ul contului oficial Swypik
   (`NEXT_PUBLIC_SWYPIK_OFFICIAL_USER_ID`).
2. Din contul oficial: `/creator/movies` → serial nou (poster 9:16, sinopsis, notă de
   licență), episoade din clipuri deja procesate ȘI aprobate la moderare, „Trimite la review".
3. `/admin/movies` → Publică. Primele 3 episoade devin `public` (apar în `/explore`
   cu insigna Movies), restul rămân `private` și se redau doar prin proxy-ul cu token.
4. Verifică o deblocare cu SWYP dintr-un cont de test și că ledger-ul are două intrări
   cu același `ref_id` (`movie_unlock` + `movie_creator_share`) — pentru serialele
   contului oficial cota este 0, deci o singură intrare.

## Rollback

`FEATURE_MOVIES=0` + `NEXT_PUBLIC_FEATURE_MOVIES=0` în env și rebuild `web-next`:
rutele răspund 410, paginile 404, intrarea din meniu dispare. Tabelele rămân (goale
sau nu) și nu afectează restul aplicației; trigger-ul de vizibilitate acționează doar
pe videoclipurile care sunt episoade.
