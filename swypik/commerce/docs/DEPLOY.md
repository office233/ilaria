# Deploy Swypik (apps/web — Next.js)

Ghid operațional: variabile de mediu, chei, cron, webhook-uri Stripe, migrări.

---

## 0. Cum se face deploy (și de ce arată așa scriptul)

```bash
wsl -d swypik -e bash /opt/swypik/app/scripts/deploy/wsl-deploy-web.sh            # tot codul
wsl -d swypik -e bash /opt/swypik/app/scripts/deploy/wsl-deploy-web.sh web-next   # un serviciu
PRUNE=1 bash scripts/deploy/wsl-deploy-web.sh                                     # curăță cache-ul întâi
MIN_FREE_GB=20 bash scripts/deploy/wsl-deploy-web.sh                              # prag de spațiu mai strict
NO_PULL=1 bash scripts/deploy/wsl-deploy-web.sh                                   # fără git pull
```

Coduri de ieșire: `0` toate serviciile au imagine nouă · `1` deploy incomplet
(hash identic) · `2` eroare de configurare, spațiu insuficient sau build eșuat.

### Servicii cu cod de aplicație

| Serviciu | Context build | Conținut |
| --- | --- | --- |
| `web-next` | `/opt/swypik/app` | Next.js: `app/`, `lib/`, `components/` |
| `platform-api` | `services/platform-api` | Go |
| `video-worker` | `workers/video-worker` | Python, transcodare HLS |
| `cron-worker` | `infra/hetzner/cron-worker` | `run.sh`, declanșator de cron |

Restul (`postgres`, `redis`, `minio`) sunt imagini externe pinned;
`caddy` și `pgbouncer` sunt dezactivate prin `profiles: [disabled]`.

### Trei capcane care ne-au costat producția

**1. Deploy parțial raportat ca succes** (10 și 17 august)
Scriptul rula `up -d --build web-next` — un singur serviciu. Fix-ul P1-01
(timeout ffmpeg în `video-worker`) a stat 2 zile în `main`, comis și pushed,
fără să ruleze în producție. Nimic nu semnala asta.
*Acum:* rebuild pentru toate serviciile cu cod, cu hash-ul imaginii comparat
înainte/după și `exit 1` dacă vreunul a rămas identic.

**2. Scriptul care se auto-actualizează** (17 august)
`git pull` e în interiorul scriptului, dar bash citește fișierul o singură dată
la pornire. Prima rulare a versiunii noi a executat de fapt versiunea *veche*
adusă de propriul pull, a raportat `exit 0` și a lăsat 3 din 4 servicii
nereconstruite — exact eroarea pe care versiunea nouă o prevenea.
*Acum:* se compară `sha256` al scriptului înainte/după pull și, dacă s-a
schimbat, se face `exec` o singură dată (`DEPLOY_REEXEC=1` previne bucla).

**3. Discul plin → producție căzută** (17 august, ~40 min downtime)
Cache-ul BuildKit ajunsese la **64,81 GB** (63,67 recuperabili, 0 activ).
Rebuild-ul paralel al celor 4 servicii a consumat ultimii GB de pe `D:`.
VHDX-ul WSL nu a mai putut crește → filesystem-ul distro-ului s-a remontat
`emergency_ro` → binarele au început să dea `Input/output error` → daemonul
Docker a murit → **502 pe swypik.com**.

Capcana specifică: `df` din interiorul WSL raporta **885 GB liberi** în timp ce
partiția gazdă avea **0,03 GB**. VHDX-ul crește dinamic, deci spațiul văzut din
distro nu spune nimic despre spațiul real.

*Acum:* scriptul verifică ambele niveluri (`DockerRootDir` **și** partiția
gazdă) și refuză să pornească sub 10 GB; build secvențial, cu recheck între
servicii.

> **Actualizare 19 august — distro-ul s-a mutat pe `E:`.**
> VHDX-ul e la `E:\wsl\swypik\ext4.vhdx` (era `D:\Swypik\wsl\swypik\`).
> Era umflat de 5,4×: 73,2 GB pe disc, 23 GB folosiți în interior, din care
> 11,59 GB build cache cu 0 activ. După `docker builder prune -af` +
> export/import: **13,64 GB**. Recuperat 73 GB pe `D:`. Downtime 21 min.
>
> Monitorizarea a fost mutată odată cu el, pe `/mnt/e`
> (`scripts/ops/disk-watch.sh`, `scripts/deploy/wsl-deploy-web.sh`). Lăsată pe `/mnt/d`,
> ar fi fost mai rea decât inexistentă: raporta 148 GB liberi de pe o partiție
> care nu mai are legătură cu problema, în timp ce `E:` s-ar fi putut umple în
> tăcere. Aceeași capcană ca pe 17 august, doar mai greu de observat.
>
> La o mutare viitoare: `DISK_WATCH_MOUNT` și `HOST_MOUNT` sunt suprascriabile
> din mediu, iar `.wslconfig` are `swapFile` cu cale absolută — se actualizează
> și el.

*Recuperare, dacă se repetă:* eliberează spațiu pe gazdă, apoi `wsl --shutdown`
și repornește distro-ul — `emergency_ro` nu dispare de la sine, oricât spațiu
ai elibera între timp. Containerele au `restart: unless-stopped` și revin singure.

*Notă:* după acel incident, layerele imaginii `golang` scrise în `emergency_ro`
au rămas cu binare de 0 bytes. Dacă un build Go eșuează cu
`"/bin/api": not found`, verifică întâi `docker run --rm golang:<tag> go version`.

### Igienă periodică

```bash
docker system df                 # cât ocupă imagini / volume / build cache
docker builder prune -af         # cache-ul de build crește nelimitat implicit
```

Cache-ul de build a fost cauza-rădăcină a incidentului. Din 17 august e limitat
prin `/etc/docker/daemon.json`:

```json
{ "builder": { "gc": { "enabled": true, "defaultKeepStorage": "10GB",
  "policy": [ { "keepStorage": "10GB", "all": true } ] } } }
```

GC-ul taie cache-ul la 10 GB pe măsură ce se fac build-uri. Fișierul nu exista
înainte; după modificare e nevoie de `sudo service docker restart` (containerele
revin singure în ~15 s prin `restart: unless-stopped`).

### Alertă de spațiu

`app/api/cron/disk-watch/route.ts` alertează prin `notifyOps` sub 15 GB liberi
(`critical` sub 5 GB). Pragul: `DISK_WATCH_MIN_FREE_GB`.

Măsurătoarea vine din afara containerelor, prin `scripts/ops/disk-watch.sh`, pentru
că **niciun container nu vede discul gazdei** — nu există bind mount-uri, iar
`df` dinăuntru raportează capacitatea VHDX-ului, nu partiția fizică. În timpul
incidentului containerele „vedeau" 885 GB liberi cu gazda la 0,03 GB.

Instalare în crontab-ul gazdei WSL (după ce ruta e deployată):

```bash
crontab -e
0 * * * * /opt/swypik/app/scripts/ops/disk-watch.sh >> /var/log/swypik-disk-watch.log 2>&1
```

> **⚠ ÎNCĂ NEFĂCUT — MONITORIZAREA DE DISC E OPRITĂ DIN 19 AUGUST.**
>
> Confirmat pe 21 august prin `cron_runs`: ultima rulare `disk-watch` e
> `2026-08-19T13:19`, deși celelalte joburi orare rulează normal. Pasul de mai
> jos a fost documentat, deploy-ul s-a făcut — dar comanda nu a fost executată.
> Avertismentul a devenit exact defectul pe care îl prevedea.
>
> Scriptul s-a mutat din
> `scripts/` în `scripts/ops/`, dar crontab-ul de pe gazdă indică încă
> `/opt/swypik/app/scripts/disk-watch.sh`. Linia NU a fost schimbată
> intenționat: `/opt` e o copie separată a repo-ului, actualizată abia la
> `git pull`-ul din deploy. Schimbată acum, cron-ul ar fi rulat un fișier
> inexistent — adică fix eșecul tăcut pe care monitorizarea trebuie să-l
> prevină.
>
> Deploy-ul a fost făcut pe 19 august (`8f525c3f` și anterioare). Rulează acum:
> ```bash
> crontab -l | sed 's#scripts/disk-watch.sh#scripts/ops/disk-watch.sh#' | crontab -
> crontab -l | grep disk-watch          # confirmă calea nouă
> bash /opt/swypik/app/scripts/ops/disk-watch.sh   # confirmă că rulează
> ```
>
> **Lecția, pentru data viitoare:** un pas manual amânat până după deploy nu
> are cine să-l reamintească. Documentul l-a descris corect, dar documentele nu
> execută. Dacă pasul e obligatoriu, locul lui e în scriptul de deploy, nu
> într-un avertisment.

Verificare că funcționează:
```bash
bash /opt/swypik/app/scripts/ops/disk-watch.sh          # așteptat: http 200 + GB liberi
DISK_WATCH_MIN_FREE_GB=2000                          # forțează alerta, apoi scoate-l
psql -c "SELECT alert_key, alerted_at FROM ops_alert_log ORDER BY alerted_at DESC LIMIT 3;"
```

---

## 1. Verificarea configurației

Înainte de orice deploy:

```bash
NODE_ENV=production node scripts/check-env.mjs
```

Scriptul iese cu cod `1` dacă lipsesc variabile obligatorii. Citește `.env.local` apoi `.env`
(fără să suprascrie variabilele deja prezente în mediu), deci funcționează și în CI unde
variabilele vin din secret store.

---

## 2. Variabile obligatorii

| Variabilă | Rol |
| --- | --- |
| `DATABASE_URL` | conexiune PostgreSQL (`postgresql://user:pass@host:port/db`) |
| `APP_ENCRYPTION_KEY` | criptare tokenuri sociale + semnare linkuri unsubscribe. Generare: `openssl rand -hex 32` |
| `NEXT_PUBLIC_APP_URL` | URL public canonic (linkuri e-mail, redirect-uri) |

Obligatorii **doar în producție** (în dev au fallback-uri locale):

| Variabilă | Rol |
| --- | --- |
| `CRON_SECRET` | autentifică rutele `/api/cron/*` (`Authorization: Bearer $CRON_SECRET`) |
| `STRIPE_SECRET_KEY` | plăți |
| `STRIPE_WEBHOOK_SECRET` | verificarea semnăturii webhook Stripe |
| `OAUTH_REDIRECT_BASE` | baza pentru callback-urile OAuth |
| `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_CHAT_DEPLOYMENT`, `AZURE_OPENAI_WHISPER_DEPLOYMENT` | Azure AI Foundry (chat, subtitrări) — `lib/ai/azure` |
| `AZURE_CONTENT_SAFETY_ENDPOINT`, `AZURE_CONTENT_SAFETY_KEY` | moderare text + imagine (praguri `CONTENT_SAFETY_*`) |
| `GO_API_URL` | platform API Go (upload video, feed) |

> În dev, `GO_API_URL` cade pe `http://localhost:8080`, `OAUTH_REDIRECT_BASE` pe
> `http://localhost:3000`. Fără cheile Azure AI, funcțiile AI se opresc curat (moderare doar
> euristică, fără știri/subtitrări); în producție lipsa GO_API_URL / OAUTH produce un **log de eroare explicit**.

## 3. Variabile recomandate / de business

| Variabilă | Default | Rol |
| --- | --- | --- |
| `CREATOR_COMMISSION_BPS` | `500` | comision creator, în basis points (500 = 5%) |
| `PAYOUT_MIN_CENTS` | `5000` | prag minim retragere curieri (cenți) |
| `PLATFORM_USER_ID` | id determinist din migrarea `20260730_0013` | cont tehnic pentru comisioane în `wallet_ledger` |
| `DEFAULT_TIMEZONE` | `Europe/Bucharest` | fus orar implicit (i18n + misiuni zilnice) |
| `LIVE_RTMP_HOST` / `LIVE_HLS_HOST` | `swypik.com` (doar dev) | hosturi live streaming |
| `SOCIAL_API_URL` | fallback `GO_API_URL` | proxy către API-ul social |
| `FEED_EVENT_IP_SALT` | valoare implicită | salt pentru hashing IP la evenimente feed |
| `RESEND_API_KEY` | – | e-mailuri tranzacționale; fără el, e-mailurile doar se loghează |
| `GOOGLE_MAPS_API_KEY` | – | estimări rută (fallback: haversine) |

### Recomandare pentru un pas ulterior

Constantele din `lib/dispatch/engine.ts` (`OFFER_TTL_SECONDS`, `WAVE_RADII_KM`,
`MAX_COURIERS_PER_WAVE`) ar trebui mutate în env. **Nu au fost modificate** aici pentru a evita
conflicte cu munca în curs pe motorul de dispatch.

---

## 4. Chei VAPID (push web)

```bash
npx web-push generate-vapid-keys
```

Setează:

```
VAPID_PUBLIC_KEY=BM...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:contact@swypik.com
```

Cheia publică este servită clientului prin `GET /api/push/vapid-public-key`. Dacă lipsesc,
push-ul este dezactivat cu un warning în loguri (nu blochează aplicația).

---

## 5. Cron

### `/api/cron/dispatch-tick` — la fiecare 10 secunde

Expirarea ofertelor către curieri **nu** poate fi doar client-side. Rulează un cron extern
(systemd timer nu coboară sub 1s util aici; cel mai simplu e o buclă în systemd sau un
`while` cu `sleep 10`):

`/etc/systemd/system/swypik-dispatch-tick.service`:

```ini
[Unit]
Description=Swypik dispatch tick (10s)

[Service]
Type=simple
Environment=CRON_SECRET=__PUNE_SECRETUL__
Environment=APP_URL=https://swypik.com
ExecStart=/bin/bash -c 'while true; do curl -fsS -m 8 -H "Authorization: Bearer $CRON_SECRET" "$APP_URL/api/cron/dispatch-tick" >/dev/null || true; sleep 10; done'
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now swypik-dispatch-tick
```

### Restul cron-urilor (crontab clasic)

```cron
*/5  * * * * curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://swypik.com/api/cron/process-dropship
*/15 * * * * curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://swypik.com/api/cron/swyp-view-milestones
```

Toate rutele `/api/cron/*` compară secretul în timp constant (`timingSafeEqual`).

---

## 6. Webhook-uri Stripe

Endpoint principal: `https://swypik.com/api/webhooks/stripe` → secret în `STRIPE_WEBHOOK_SECRET`.

Evenimente de înregistrat:

- `checkout.session.completed`
- `checkout.session.async_payment_failed`
- `checkout.session.expired`
- `payment_intent.succeeded`
- `payment_intent.payment_failed`
- `payment_intent.canceled`
- `charge.refunded`
- `account.updated` (Stripe Connect — onboarding creatori/curieri)
- `charge.dispute.created` / `.updated` / `.closed` / `.funds_withdrawn` / `.funds_reinstated`

Endpoint separat pentru identitate: `https://swypik.com/api/webhooks/stripe-identity`
(secret propriu), cu evenimentele:

- `identity.verification_session.verified`
- `identity.verification_session.requires_input`
- `identity.verification_session.canceled`

Evenimentele sunt deduplicate în tabela `processed_stripe_events` (idempotent la retry-uri Stripe).

---

## 7. Migrări pe producție

```bash
# dry-run: vezi ce s-ar aplica
npm run db:status

# aplică migrările
DATABASE_URL="postgresql://..." npm run db:migrate
```

Ordinea recomandată la deploy:

1. `node scripts/check-env.mjs` (cod 0)
2. backup DB (`pg_dump`)
3. migrări
4. `npm run build`
5. restart aplicație
6. smoke test: `/api/health`, login, un checkout de test

---

## 7b. Deploy pe producție (WSL) — și capcana deploy-ului parțial

**Producția rulează în WSL local**, distro `swypik`, containere `swypik-prod-*`.
Nu pe VPS extern. Repo-ul de deploy e `/opt/swypik/app`, un clone separat care
trage din `origin` — deci **orice commit trebuie mai întâi `git push`**, altfel
`git pull` de pe prod nu are ce aduce.

```bash
bash scripts/deploy/wsl-deploy-web.sh                    # tot codul de aplicație
bash scripts/deploy/wsl-deploy-web.sh web-next           # doar un serviciu
bash scripts/deploy/wsl-deploy-web.sh video-worker cron-worker
NO_PULL=1 bash scripts/deploy/wsl-deploy-web.sh          # fără git pull
```

### Serviciile care conțin cod din repo

Doar acestea au `build:` în compose și pot rămâne în urmă la un deploy parțial:

| Serviciu | Context de build | Ce conține |
| --- | --- | --- |
| `web-next` | `/opt/swypik/app` | Next.js: `app/`, `lib/`, `components/`, rutele API |
| `platform-api` | `services/platform-api` | Go: upload video, feed |
| `video-worker` | `workers/video-worker` | Python: transcodare HLS (3 replici) |
| `cron-worker` | `infra/hetzner/cron-worker` | `run.sh` — declanșatorul joburilor cron |

Restul sunt imagini externe pinned (`postgres`, `redis`, `minio`) sau
dezactivate prin `profiles: [disabled]` (`caddy`, `pgbouncer`). Nu se reconstruiesc.

### ⚠️ Capcana: „deploy reușit" ≠ „cod nou în producție"

Două incidente reale, același tipar:

- **10 august** — `git pull` a raportat „Already up to date", dar imaginea
  `web-next` era veche de 22 de ore. Commit-ul era pushed; containerul rula cod vechi.
- **17 august** — deploy-ul a reconstruit corect `web-next`, dar scriptul de atunci
  avea hardcodat `up -d --build web-next`. Fix-ul **P1-01** (timeout `ffmpeg`, care
  împiedică blocarea întregii cozi de transcodare) stătea de 2 zile în `main`,
  comis și pushed, **fără să ruleze**. Imaginea `video-worker` era din 10 august.

De ce nu se observă: `git pull` reușește, `docker compose up` iese cu 0,
containerul e `healthy`, site-ul răspunde 200. Niciun semnal de eroare.

**Regula: singura dovadă că s-a livrat cod nou e schimbarea hash-ului imaginii.**
Scriptul o verifică automat și iese cu cod ≠ 0 dacă vreun serviciu atins a rămas
pe același hash. Nu te baza pe absența erorilor.

### Verificare manuală după deploy

```bash
# hash + data imaginii
docker inspect --format='{{.Image}} {{.Created}}' swypik-prod-web-next-1
docker inspect --format='{{.Image}} {{.Created}}' swypik-prod-video-worker-1

# build id-ul Next.js (se schimbă la fiecare build)
docker exec swypik-prod-web-next-1 sh -c 'cat .next/BUILD_ID'

# fix-ul e chiar în bundle? (exemplu: un string introdus de fix)
docker exec swypik-prod-web-next-1 sh -c "grep -rl 'video_not_available' .next/server | head -3"

# pentru workerii Python, verifică fișierul sursă din container
docker exec swypik-prod-video-worker-1 sh -c "grep -n 'FFMPEG_TIMEOUT_SECONDS' /app/video_worker/ffmpeg_tools.py"
```

Dacă hash-ul a rămas identic, forțează:

```bash
cd /opt/swypik/app
docker compose -f infra/hetzner/docker-compose.prod.yml \
  -f infra/hetzner/docker-compose.vps.yml \
  -f infra/hetzner/docker-compose.minio.yml \
  --env-file infra/hetzner/.env.production \
  build --no-cache <serviciu>
```

### Ordinea la un deploy cu migrație

Migrația **înaintea** deploy-ului, dacă noul cod scrie valori pe care schema veche
le respinge. Exemplu concret: `runCron` a început să scrie `status='skipped'` în
`cron_runs`, valoare pe care `cron_runs_status_check` nu o accepta încă —
deploy-ul înainte de migrație ar fi produs erori la fiecare skip.

După orice migrație, resincronizează oglinda schemei:

```bash
bash scripts/db/check-schema-drift.sh --write && git add db/schema.sql
```

---

## 8. Note de securitate

- Toți identificatorii publici (slug-uri, token-uri de claim) sunt generați cu
  `crypto.randomUUID()` / `randomBytes`, nu cu `Math.random()`.
- Nu comite `.env.local`. Secretele stau în secret store-ul platformei de hosting.
- Rotația `APP_ENCRYPTION_KEY` invalidează tokenurile sociale criptate — planifică re-autentificare.
