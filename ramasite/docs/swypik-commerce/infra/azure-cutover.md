# Swypik — mutarea de pe WSL (PC-ul de acasă) pe Azure

> **27.09.2026 — cutover-ul public este efectuat.** Nu relua pașii de DROP/restore
> din acest document pe baza activă. Vezi `../audits/2026-09-27-azure-readiness.md`
> pentru starea verificată, repararea celor două tuneluri, backupul restaurat de probă
> și blocajele de lansare. WSL are schema veche și nu este un rollback direct sigur.
> **28.09.2026 — Multi-ERP (erp.swypik.com) a fost retras definitiv;** pașii ERP au fost
> scoși din acest runbook. Instrumentul sellerului este panoul nativ `/seller`.

Runbook pentru cutover. Totul rulează în Docker Compose pe VM-uri Ubuntu 24.04,
fără servicii gestionate Azure în calea critică: aceleași fișiere merg și pe
Hetzner (vezi `docs/infra/scaling.md`). Creditele Microsoft for Startups
expiră la ~180 de zile după verificare → arhitectura e gândită să poată pleca
de pe Azure fără rescriere.

## 0. Arhitectura țintă

```
                    Cloudflare (DNS, WAF, Tunnel, R2 + CDN pentru media)
                         │  un singur tunel, câte un conector pe fiecare nod web
          ┌──────────────┼───────────────┐
          ▼              ▼               ▼
   web-1 10.60.1.10   web-2 10.60.1.11  (web-N …)        snet-web
   cloudflared        cloudflared
   web-next :3005     web-next :3005     ← stateless, identice
   platform-api :8090 platform-api :8090
   cron-worker        (doar web-1: joburile rulează o dată)
          │                     │
          └──────────┬──────────┘
                     ▼
   data 10.60.2.10  (fără IP public)                      snet-data
   Postgres 16 pgvector :5432 · Redis 7 :6379 (coada video)
   disc Premium SSD /srv/data
                     ▲
   worker-1 10.60.3.10                                     snet-worker
   video-worker × N  (consumator Redis Stream → ffmpeg → R2)
```

- **Ingress:** exclusiv Cloudflare Tunnel (conexiuni de ieșire). NSG-urile
  refuză tot inbound-ul, cu excepția fluxurilor interne (web→data 5432/6379,
  worker→data 5432/6379, SSH din subnetul web).
- **Ieșire:** NAT Gateway (un singur IP public de ieșire — util pentru
  whitelisting la parteneri). Niciun VM nu are IP public, cu excepția opțională a
  jump host-ului web-1 (SSH doar din IP-ul tău).
- **Media:** Cloudflare R2 (bucket NOU). Media existentă (MinIO de pe WSL) e
  demo și **NU se migrează**. MinIO și mediamtx dispar (live/apeluri → Cloudflare
  Realtime, alt proiect).
- **Fișiere:**
  - `infra/azure/main.bicep` (+ `modules/vm.bicep`, `main.parameters.json`) — rețea, VM-uri, buget;
  - `infra/azure/cloud-init.yaml` — comun tuturor rolurilor (rolul e injectat de Bicep);
  - `infra/azure/compose/{web,data,worker}.yml` — câte un fișier per rol;
  - `infra/azure/deploy.sh` (+ `node/*.sh`) — deploy git-only, rolling, migrări o singură dată;
  - `infra/azure/preflight.sh` — validează env-urile fără să afișeze valori;
  - `infra/azure/maintenance/` — Worker Cloudflare cu pagina de mentenanță;
  - `infra/azure/backup-db.sh` — backup zilnic + off-site (livrat de alt task).

## 1. Ce trebuie să furnizeze owner-ul

| # | Ce | Unde ajunge |
|---|----|-------------|
| 1 | Aprobare cost + confirmare că creditele sunt active (portal → Cost Management → Credits) | — |
| 2 | Cheia ta publică SSH (`ssh-ed25519 …`) | `adminSshPublicKey` |
| 3 | O pereche de chei **nouă** de deploy intern: `ssh-keygen -t ed25519 -f swypik_deploy -C swypik-deploy -N ""` | `.pub` → `deploySshPublicKey`; cheia privată → web-1 `/home/dev/.ssh/swypik_deploy` |
| 4 | IP-ul tău public /32 pentru SSH pe durata migrării (opțional; altfel doar `az vm run-command`) | `sshAllowedSourceCidr` |
| 5 | Email pentru alertele de buget + luna de start | `budgetContactEmails`, `budgetStartDate` |
| 6 | Acces de citire la GitHub pentru web-1 (deploy key read-only pe `office233/swypik-commerce-platform`) | `/home/dev/.ssh/` pe web-1 |
| 7 | Tokenul tunelului Cloudflare existent (Zero Trust → Networks → Tunnels → tunelul Swypik → *Install connector*) | `/etc/cloudflared/tunnel.env` pe fiecare web |
| 8 | R2 gata: bucket nou, domeniu public/CDN, token API S3 (Object Read & Write pe bucket) | `swypik.env` (chei `S3_*`/`R2_*`) |
| 9 | Chei noi / confirmate: `APP_ENCRYPTION_KEY` (vezi §2.3), parolele Postgres/Redis noi | `swypik.env`, `data.env` |
| 10 | O fereastră de ~30 min cu trafic mic pentru cutover (downtime efectiv 10–15 min) | — |

## 2. Pre-flight (cu câteva zile înainte)

### 2.1 Abonament, cote, regiune

```bash
az login
az account set -s 049dec61-3ee7-4af6-af09-29e7047fb0b9
az vm list-usage -l polandcentral -o table | grep -Ei 'total regional|DASv5|EASv5'
az vm list-skus -l polandcentral --size Standard_D2as_v5 -o table   # fără "NotAvailableForSubscription"
az vm list-skus -l polandcentral --size Standard_E2as_v5 -o table
```

Configurația implicită folosește 2×2 (web) + 2 (data) + 2 (worker) = **8 vCPU**
din cota de 65. Cota Spot e doar 3 vCPU → `workerUseSpot=false`.
Dacă `polandcentral` nu are capacitate: `germanywestcentral`, sau
`swedencentral` (~12% mai ieftin) — doar parametrul `location` se schimbă.
**Nu atinge** RG-ul existent `rg-vargaabel12-4321`.

### 2.2 Cloudflare

- Tunelul existent e *remote-managed* (token). Același token rulează pe toate
  nodurile web → Cloudflare balansează între conectori (HA fără Azure Load Balancer).
- Rutele publice (Zero Trust → Tunnels → *Public Hostnames*) rămân pe `localhost`,
  pentru că porturile sunt aceleași pe WSL și pe nodurile web:
  `swypik.com`, `www.swypik.com` → `http://localhost:3005`;
  `api.swypik.com` → `http://localhost:8090`.
- `cdn.swypik.com` (era MinIO) → devine domeniul R2 (sau un redirect), configurat
  de task-ul R2.
- Un token API Cloudflare (sau `npx wrangler login`) pentru Worker-ul de mentenanță.

### 2.3 Fișierele env (asamblate în distro-ul WSL, NU pe Windows, NU în git)

Pe WSL, ca `dev`: `mkdir -m 700 ~/azure-env && cd ~/azure-env`, apoi:

**`swypik.env`** = copie a `/opt/swypik/app/infra/hetzner/.env.production`, cu:
- `DATABASE_URL=postgres://swypik:<PAROLĂ_NOUĂ_URL-encoded>@10.60.2.10:5432/swypik_prod`
- `REDIS_URL=redis://:<REDIS_PASSWORD>@10.60.2.10:6379/0`
- storage → R2: `S3_ENDPOINT`/`S3_ENDPOINT_URL=https://<account>.r2.cloudflarestorage.com`,
  `S3_ACCESS_KEY(_ID)`, `S3_SECRET_KEY`/`S3_SECRET_ACCESS_KEY`, `S3_BUCKET`/`S3_MEDIA_BUCKET`,
  `S3_PUBLIC_URL`/`S3_PUBLIC_BASE_URL`, `S3_REGION=auto` (lista exactă de la task-ul R2);
- șterse: `MINIO_*`, orice cheie crypto/SWYP, `YOUTUBE_*`, `TMDB_*`, `MYSTERY*`;
- `APP_ENCRYPTION_KEY`: **dacă există deja în prod, se păstrează IDENTIC** (cu ea
  sunt criptate secretele TOTP, CNP-urile, token-urile
  de stream; o cheie nouă le face ilizibile). Doar dacă lipsește:
  `openssl rand -hex 32`;
- restul secretelor (`CRON_SECRET`, `ADMIN_SECRET`,
  `PLATFORM_API_SECRET`, `FEED_EVENT_IP_SALT`, Stripe, Resend…) se păstrează identic.

**`data.env`** (doar pe nodul data):
```
DATA_BIND_IP=10.60.2.10
POSTGRES_DB=swypik_prod
POSTGRES_USER=swypik
POSTGRES_PASSWORD=<aceeași parolă ca în DATABASE_URL, ne-encodată>
REDIS_PASSWORD=<openssl rand -hex 24>
```

Validare (nu afișează valori):
```bash
bash /opt/swypik/app/infra/azure/preflight.sh --env ~/azure-env/swypik.env \
  --data-env ~/azure-env/data.env --scan
```
Trebuie `REZULTAT: OK`. Lista de la `--scan` e informativă (chei cu default).

## 3. Provizionare (owner / coordonator, după aprobare)

```bash
cd E:/Swypik/swypik/app            # sau clona din WSL
az group create -n rg-swypik-prod -l polandcentral --tags app=swypik env=prod
# completează infra/azure/main.parameters.json (placeholder-ele <OWNER: …>) — local, nu comite cheile tale
az deployment group what-if -g rg-swypik-prod \
  -f infra/azure/main.bicep -p infra/azure/main.parameters.json
az deployment group create -g rg-swypik-prod -n swypik-infra \
  -f infra/azure/main.bicep -p infra/azure/main.parameters.json
az deployment group show -g rg-swypik-prod -n swypik-infra --query properties.outputs
```

Verifică bootstrap-ul (fără SSH):
```bash
for vm in web-1 web-2 data worker-1; do
  az vm run-command invoke -g rg-swypik-prod -n swypik-prod-$vm --command-id RunShellScript \
    --scripts "cat /etc/swypik/role /var/lib/swypik/cloud-init.done; docker --version; df -h /srv/data | tail -1"
done
```

## 4. Pregătirea nodurilor

Acces SSH (dacă ai setat `sshAllowedSourceCidr`): `ssh swypikadmin@<jumpHostPublicIp>`;
spre nodurile private: `ssh -J swypikadmin@<jump> swypikadmin@10.60.2.10`.

**web-1** (nod de control):
```bash
sudo -iu dev
install -m 600 /dev/stdin ~/.ssh/swypik_deploy        # lipește cheia PRIVATĂ de deploy, Ctrl-D
# deploy key GitHub read-only → ~/.ssh/github_swypik (+ ~/.ssh/config pentru github.com)
git clone git@github.com:office233/swypik-commerce-platform.git /opt/swypik/app
cat > /opt/swypik/env/hosts.env <<'EOF'
WEB_HOSTS="10.60.1.10 10.60.1.11"      # primul = acest nod (control)
WORKER_HOSTS="10.60.3.10"
DATA_HOST="10.60.2.10"
SSH_KEY=/home/dev/.ssh/swypik_deploy
PUBLIC_URL=https://swypik.com
REGISTRY_PREFIX=                        # gol = imaginile merg prin docker save | ssh
EOF
for h in 10.60.1.11 10.60.2.10 10.60.3.10; do ssh -i ~/.ssh/swypik_deploy -o StrictHostKeyChecking=accept-new dev@$h hostname; done
```

Copierea env-urilor din WSL (fișierele nu ating discul Windows):
```bash
# în distro-ul WSL, ca dev:
J=swypikadmin@<jumpHostPublicIp>
ssh $J 'sudo install -m 600 -o dev -g dev /dev/stdin /opt/swypik/env/swypik.env'    < ~/azure-env/swypik.env
ssh -J $J swypikadmin@10.60.2.10 'sudo install -m 600 -o dev -g dev /dev/stdin /opt/swypik/env/data.env' < ~/azure-env/data.env
```
(`swypik.env` ajunge pe celelalte noduri automat, la fiecare deploy.)

**Tokenul tunelului** pe fiecare nod web (NU porni serviciul):
```bash
ssh -J $J swypikadmin@10.60.1.11 \
  'sudo install -m 600 /dev/stdin /etc/cloudflared/tunnel.env' <<< "TUNNEL_TOKEN=<token>"
# la fel pentru web-1 (direct prin $J)
```

**Nodul data** — pornește serviciile (din web-1, ca dev):
```bash
git -C /opt/swypik/app archive HEAD infra/azure | ssh -i ~/.ssh/swypik_deploy dev@10.60.2.10 \
  'mkdir -p /opt/swypik/release && tar -x -C /opt/swypik/release'
ssh -i ~/.ssh/swypik_deploy dev@10.60.2.10 \
  'docker compose -p swypik-data -f /opt/swypik/release/infra/azure/compose/data.yml --env-file /opt/swypik/env/data.env up -d && docker ps'
pg_isready -h 10.60.2.10 -p 5432
REDISCLI_AUTH="$(grep -oP '^REDIS_URL=redis://:\K[^@]+' /opt/swypik/env/swypik.env)" redis-cli -h 10.60.2.10 ping
bash /opt/swypik/app/infra/azure/preflight.sh --env /opt/swypik/env/swypik.env
```

## 5. Repetiția (WSL rămâne live; zero impact)

Scop: validezi tot lanțul și **cronometrezi** dump/transfer/restore.

1. **Dump-uri pe WSL** (format custom, comprimat):
   ```bash
   wsl -d swypik -u root -- bash -c '
     cd /opt/swypik/backups &&
     docker exec swypik-prod-postgres-1 pg_dump -U swypik -d swypik_prod -Fc -Z 6 > rehearsal-swypik.dump &&
     ls -lh rehearsal-*.dump && sha256sum rehearsal-*.dump'
   ```
2. **Transfer** pe nodul data (din WSL, ca root; notează durata):
   ```bash
   time ssh -J $J swypikadmin@10.60.2.10 'sudo install -m 600 /dev/stdin /srv/data/backups/rehearsal-swypik.dump' < /opt/swypik/backups/rehearsal-swypik.dump
   ```
3. **Restore** (pe nodul data, `sudo -iu dev`):
   ```bash
   restore() { # CONTAINER DUMP
     docker cp "$2" "$1":/tmp/restore.dump
     docker exec "$1" sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges -j 2 /tmp/restore.dump; rm /tmp/restore.dump'
   }
   time restore swypik-postgres    /srv/data/backups/rehearsal-swypik.dump
   ```
   Mesaje de tipul `schema "public" already exists` sunt normale (baza goală
   creată de imagine); orice altă eroare se investighează înainte de cutover.
   Compară cu WSL: `select count(*) from users; … videos; … commerce_orders; select count(*), max(version) from schema_migrations;`.
4. **Primul deploy** pe Azure, **fără cron** (copia bazei nu trebuie să trimită
   emailuri, să proceseze plăți sau să publice știri):
   ```bash
   # pe web-1:
   sudo -iu dev bash /opt/swypik/app/infra/azure/deploy.sh --no-cron --services "video-worker"
   ```
   Verifică: `curl -s localhost:3005/api/health` pe fiecare nod web, `docker ps` pe worker.
5. **Test din browser fără tunelul de producție**: pe web-1
   `cloudflared tunnel --no-autoupdate --url http://localhost:3005` (tunel rapid
   `*.trycloudflare.com`, temporar) — pagini publice, feed, căutare. Login-ul
   poate cere domeniul real (cookie-uri); asta se verifică la cutover.
6. Notează timpii: dump + transfer + restore ≈ downtime-ul real (+ ~4 min fix).
7. **Curăță** copia înainte de cutover (pe nodul data):
   ```bash
   docker exec swypik-postgres    sh -c 'psql -U "$POSTGRES_USER" -d postgres -c "DROP DATABASE $POSTGRES_DB WITH (FORCE)" -c "CREATE DATABASE $POSTGRES_DB"'
   REDISCLI_AUTH=<parola> redis-cli -h 10.60.2.10 FLUSHALL    # coada/cache-ul copiei
   ```

## 6. Cutover (T = începutul ferestrei; downtime așteptat 10–15 min)

**T−30 min — aliniază versiunea.** WSL și Azure rulează același commit:
```bash
curl -s https://swypik.com/api/health | grep -o '"commit":"[^"]*"'
sudo -iu dev bash /opt/swypik/app/infra/azure/deploy.sh --no-cron   # pe web-1, dacă diferă
```

**T+0 — pagina de mentenanță** (din clona repo-ului, pe PC):
```bash
cd infra/azure/maintenance && npx wrangler deploy
curl -sI https://swypik.com | head -1        # HTTP/2 503
```

**T+1 — oprește scrierile pe WSL:**
```bash
wsl -d swypik -u root -- bash -c '
  cd /opt/swypik/app/infra/hetzner &&
  docker compose -p swypik-prod --env-file .env.production -f docker-compose.prod.yml -f docker-compose.vps.yml -f docker-compose.minio.yml \
    stop cron-worker video-worker web-next platform-api'
```

**T+2 — dump-urile finale** (pașii 5.1–5.2 cu numele `final-swypik.dump`) + `sha256sum` la ambele capete.

**T+6 — restore** (pasul 5.3 cu `final-*.dump`, pe bazele goale de la 5.7), apoi:
```bash
docker exec swypik-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "ANALYZE" -c "SELECT social_resync_counters();"'
```

**T+10 — repornește aplicația pe baza reală și pornește cron-ul** (pe web-1):
```bash
sudo -iu dev bash /opt/swypik/app/infra/azure/deploy.sh --skip-backup --services "video-worker cron-worker"
```
(Același commit → build-ul e din cache; migrările în așteptare = 0; dump-ul
final e deja backup-ul; repornește toate containerele pe baza restaurată.)

**T+12 — comută conectorii tunelului:**
```bash
wsl -d swypik -u root -- bash -c 'systemctl stop cloudflared && systemctl disable cloudflared'
# pe FIECARE nod web:
sudo systemctl enable --now cloudflared-swypik && systemctl is-active cloudflared-swypik
```
În Zero Trust → Tunnels → tunelul Swypik: conectorii WSL dispar, apar cei Azure
(IP de origine = `natEgressIp`).

**T+13 — ridică mentenanța și verifică (§7):**
```bash
cd infra/azure/maintenance && npx wrangler delete --name swypik-maintenance
```

## 7. Verificare

- `curl -s https://swypik.com/api/health` → `status: healthy`, commit-ul așteptat.
- Pagini: `/ro`, `/en`, `/ro/explore`, `/ro/shop`, un produs, `/ro/movies`, `/ro/music`, `/ro/news`, `/ro/gaming` → 200.
- Login OTP pe email (primești emailul), sesiune păstrată la refresh (ambele noduri web).
- Admin: `/admin` → login (sesiunile de admin se refac; vezi §9).
- **Stripe:** Dashboard → Developers → Webhooks → endpoint-ul `https://swypik.com/api/webhooks/stripe`
  → *Send test webhook* → 2xx; livrările eșuate în fereastra de mentenanță (503) se
  re-livrează automat — verifică tab-ul *Event deliveries* după ~1 h.
- Upload video de test → `video_processing_jobs` trece în `ready`, HLS pe R2 se redă.
  Coada: `REDISCLI_AUTH=… redis-cli -h 10.60.2.10 XINFO GROUPS <stream>` (pending ≈ 0).
- Cron: `docker logs --tail 50 swypik-web-cron-worker-1` pe web-1 → `OK status=200`.
- Tunel: 2+ conectori sănătoși; oprește temporar `cloudflared-swypik` pe web-2 → site-ul rămâne sus.
- Loguri fără erori noi: Sentry, `docker logs swypik-web-web-next-1`.

## 8. Rollback

- **Înainte de ridicarea mentenanței** (nimic scris pe Azure): pe nodurile web
  `sudo systemctl disable --now cloudflared-swypik`; pe WSL
  `systemctl enable --now cloudflared` + `docker compose … start web-next platform-api video-worker cron-worker`;
  șterge Worker-ul.
  Pierdere de date: zero.
- **După ridicare** (Azure a primit scrieri): rollback = procedura inversă cu
  mentenanță (dump Azure → restore pe WSL, apoi comutarea conectorilor). Decide în
  primele ore; WSL rămâne intact (oprit) 14 zile.
- **Deploy stricat ulterior:** `deploy.sh` revine singur nodul curent la tag-ul
  anterior și nu atinge nodurile următoare. Manual pe un nod:
  `SWYPIK_IMAGE_TAG=<commit_vechi> docker compose -p swypik-web -f …/web.yml up -d --no-deps web-next platform-api`.

## 9. După cutover

- [ ] `SELECT social_resync_counters();` (făcut la T+6; repetă dacă apar contoare ciudate).
- [ ] Adminii se re-autentifică în `/admin`.
- [ ] Dezactivează `E:\Swypik\wsl-keepalive.ps1` (sarcina programată / intrarea de pornire care îl rulează);
      distro-ul `swypik` rămâne oprit, neșters, 14 zile.
- [ ] Backup zilnic pe nodul data cu `infra/azure/backup-db.sh` (timer systemd, ca
      `infra/hetzner/systemd/swypik-db-backup.*`, cu `ExecStart` spre
      `/opt/swypik/release/infra/azure/backup-db.sh`) + verificarea copiei off-site.
- [ ] Nodul data (creat înainte de 2026-09-28): `sudo chown -R dev:dev /srv/data/backups` — altfel
      dump-ul pre-deploy local nu poate scrie (cloud-init nou o face singur).
- [ ] Cloudflare (owner): SSL/TLS → Edge Certificates → **Always Use HTTPS** = On și o regulă de
      redirect 301 `www.swypik.com/*` → `https://swypik.com/$1`. Aplicația redirecționează oricum
      (middleware, 308), dar la edge e mai ieftin și acoperă și fișierele statice.
- [ ] `dispatch-worker` (tick Go/Food la 10 s) rulează pe web-1 cu profilul `cron`; dacă pe web-1 mai
      există serviciul systemd vechi `swypik-dispatch`: `sudo systemctl disable --now swypik-dispatch`.
- [ ] Scoate accesul SSH public: `sshAllowedSourceCidr=""` + redeploy Bicep (rămâne `az vm run-command`).
- [ ] Reboot lunar pentru kernel (`/var/run/reboot-required`), **câte un nod**:
      web-2 → web-1 (conectorul celuilalt servește), worker, data (fereastră scurtă).
- [ ] Alertele de buget ajung la email (Cost Management → Budgets).
- [ ] Actualizează `CLAUDE.md` (secțiunile Hosting / Deploy / Containere) după 48 h stabile.
- [ ] Media veche (MinIO) nu există pe R2: înregistrările demo care o referă sunt
      ascunse/arhivate de task-ul de curățenie a datelor demo.

## 10. Cost estimat (USD/lună, pay-as-you-go Linux, fără rezervări)

Prețuri orientative (verifică în Azure Pricing Calculator pentru regiunea aleasă;
`swedencentral` e cu ~12% mai ieftin decât `polandcentral`).

| Rol | Resursă | polandcentral | swedencentral |
|-----|---------|--------------:|--------------:|
| web ×2 | Standard_D2as_v5 (2 vCPU / 8 GiB) + disc OS StandardSSD 64 GiB | ~2 × 75 = 150 | ~2 × 66 = 132 |
| data | Standard_E2as_v5 (2 vCPU / 16 GiB) + OS Premium 32 GiB | ~100 | ~88 |
| data | Premium SSD P10 128 GiB (`/srv/data`) | ~20 | ~18 |
| worker ×1 | Standard_D2as_v5 + OS StandardSSD 64 GiB | ~75 | ~66 |
| rețea | NAT Gateway (+ ~0,045/GB procesat) | ~35 | ~33 |
| rețea | IP public jump host (opțional) | ~4 | ~4 |
| trafic | ieșire internet (primii 100 GB gratuit; media vine din R2) | ~5–15 | ~5–15 |
| **Total** | | **~390** | **~345** |

Pârghii: worker `Standard_D4as_v5` când coada crește (+~75); data `E4as_v5`
(+~90) sau P15 256 GiB (+~18); `workerCount=0` temporar dacă nu se urcă video-uri
(−75; job-urile așteaptă în coadă). Creditele de 4.000 USD expiră la ~180 de zile
→ ~650 USD/lună ar fi acoperiți; bugetul de 400 e o alarmă, nu o limită.
Cloudflare R2 se plătește separat (0,015 USD/GB-lună, fără cost de egress).
