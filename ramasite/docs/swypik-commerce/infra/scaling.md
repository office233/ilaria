# Swypik — cum scalăm (Azure acum, Hetzner oricând)

Principiu: **roluri separate, totul în Docker Compose, livrare doar prin Cloudflare.**
Aceleași fișiere (`infra/azure/compose/{web,data,worker}.yml`, `cloud-init.yaml`,
`deploy.sh`) rulează pe orice VM Ubuntu 24.04 — diferă doar env-urile și IP-urile
din `/opt/swypik/env/hosts.env`. Punctul de plecare e în `docs/infra/azure-cutover.md`.

| Strat | Rol | Stare | Cum crește |
|-------|-----|-------|------------|
| Edge | Cloudflare (DNS, WAF, Tunnel, R2 + CDN) | — | automat |
| Web | web-next + platform-api + cloudflared | **stateless** | orizontal: mai multe VM-uri |
| Coadă | Redis Streams pe nodul data | persistent (AOF) | vertical / Redis dedicat |
| Worker | video-worker (ffmpeg) | fără stare | orizontal: replici / VM-uri |
| Date | Postgres 16 (pgvector) | persistent | vertical → PgBouncer → replici → gestionat |

## 1. Stratul web

### Condiții de „stateless” (verificate de auditul aplicației)
- Sesiunile sunt în Postgres (token SHA-256), rate limiting-ul și cache-ul în Redis.
- Upload-urile merg direct în R2 (URL presemnat / platform-api), nu pe discul nodului.
- Cache-ul ISR/`fetch` al Next.js e **per nod**: o pagină regenerată pe web-1 poate
  apărea cu câteva secunde mai târziu pe web-2. Acceptabil; dacă devine o problemă
  → cache handler partajat în Redis.
- Joburile programate rulează **o singură dată**: `cron-worker` doar pe web-1
  (profilul `cron`). Alternativă la N noduri: lock Redis (`SET NX EX`) în fiecare job.

### Adăugarea unui nod web (Azure)
1. `webCount` += 1 în `main.parameters.json` → `what-if` → `az deployment group create`
   (VM-ul nou primește `10.60.1.(10+N-1)`, același cloud-init).
2. Tokenul tunelului: `/etc/cloudflared/tunnel.env` pe nodul nou (§4 din runbook).
3. Adaugă IP-ul în `WEB_HOSTS` (hosts.env pe web-1) → `deploy.sh` (livrează release-ul,
   env-ul, imaginile și pornește containerele pe nod).
4. `sudo systemctl enable --now cloudflared-swypik` pe nodul nou → Cloudflare
   începe să-i trimită trafic (fiecare `cloudflared` deschide 4 conexiuni la edge;
   Cloudflare distribuie cererile între conectorii sănătoși).
5. Verifică: `max_connections` în Postgres ≥ noduri × pool-ul `pg` (vezi §3).

Scoaterea unui nod: `systemctl disable --now cloudflared-swypik` pe el (drenare),
scoate IP-ul din `WEB_HOSTS`, apoi `webCount` −1.

### Când trecem la VM Scale Set
Peste ~6 noduri sau când vrem autoscaling pe CPU:
- VMSS **Flexible** cu același `cloud-init.yaml` (rol `web`) + un pas care face
  `docker pull` al tag-ului curent → necesită un registry: setează `REGISTRY_PREFIX`
  (ex. `ghcr.io/office233/swypik`) în `hosts.env`; `deploy.sh` face deja push/pull.
- Deploy-ul trece din „SSH fan-out” în „rolling upgrade” VMSS (sau fiecare instanță
  citește la boot tag-ul curent dintr-un fișier în R2 / cheie Redis).
- Tokenul tunelului vine din Key Vault prin identitatea system-assigned (singura
  piesă Azure-specifică; pe Hetzner rămâne fișierul).

## 2. Coada video și worker-ele

- Producătorul (web-next / platform-api) scrie în Redis Stream
  (`REDIS_STREAM_VIDEO_JOBS` = `VIDEO_QUEUE_NAME`), consumer group `video-workers`.
- Fiecare container video-worker e un consumator (nume = hostname-ul containerului);
  un job neconfirmat (worker mort / VM Spot evacuat) e revendicat de alt consumator
  după `VIDEO_STALE_PENDING_MS` (10 min).
- **Scalare:**
  - pe același nod: `deploy.sh --services video-worker --video-workers 2`
    (max 2 per nod; ajustează `VIDEO_WORKER_CPUS` în `/opt/swypik/env/compose.env`);
  - mai multe noduri: `workerCount` += 1 + IP în `WORKER_HOSTS`;
  - mai mare: `workerVmSize=Standard_D4as_v5` (`VIDEO_WORKER_CPUS=3.5`, `VIDEO_WORKER_MEM_LIMIT=6g`);
  - Spot: `workerUseSpot=true` (cota Spot a abonamentului e doar 3 vCPU).
- **Semnale:** cronul `alert-video-queue` (lungime/lag/pending), plus
  `redis-cli XINFO GROUPS <stream>` / `XPENDING`. Regula: dacă lag-ul > 10 min
  în mod repetat → încă un worker.
- GPU (volume mari): `VIDEO_ENCODER=h264_nvenc` pe un VM NC/NV (Azure) sau GEX (Hetzner).

## 3. Postgres

**Pool-ul per replică** (`lib/db.ts`, w6-performance): `PG_POOL_MAX` (implicit 15), `PG_IDLE_TIMEOUT_MS`
(implicit 30 s — sub trafic în rafale, 10 s forța reconectări TCP către serverul de date la fiecare
vârf), TCP keep-alive pornit (conexiunile inactive nu mai sunt tăiate tăcut de NAT/firewall).
Regula de dimensionare: `replici web × PG_POOL_MAX + workeri video + cron + ~20 rezervă ≤ max_connections`
(300 în `infra/azure/compose/data.yml`). Ex.: 4 replici × 30 = 120; 8 replici × 30 = 240 → peste
asta, PgBouncer (pasul 2). Redis: un singur client ioredis per replică (multiplexat, keep-alive
implicit) + un abonat pentru hub-ul realtime — nu necesită dimensionare.

Ordinea firească, de la ieftin la scump:

1. **Vertical** (primul pas, minute de oprire): `dataVmSize` E2as_v5 → E4as_v5 → E8as_v5,
   apoi `PG_SHARED_BUFFERS` (~25% RAM), `PG_EFFECTIVE_CACHE_SIZE` (~60–70%),
   `PG_MEM_LIMIT`, `PG_MAX_WORKER_PROCESSES` în `data.env` și
   `docker compose -p swypik-data … up -d`. Disc: P10 → P15/P20 (IOPS cresc cu mărimea).
   Semnale: CPU > 70% susținut, cache hit < 99% (`pg_stat_database`), `pg_stat_statements`
   dominat de câteva interogări (întâi index, apoi hardware).
2. **PgBouncer** când conexiunile devin problema (noduri web × pool `pg` ≈ `max_connections`):
   container `bitnami/pgbouncer` pe nodul data (există un schelet dezactivat în
   `infra/hetzner/docker-compose.prod.yml`), `pool_mode=transaction`, port 6432;
   `DATABASE_URL` → 6432. `node-postgres` nu folosește prepared statements numite
   implicit → compatibil cu transaction pooling. Migrările rulează direct pe 5432.
3. **Replică de citire** (streaming replication) pe un al doilea VM data: feed-ul,
   căutarea și paginile publice citesc din replică. Necesită suport în aplicație
   (un `DATABASE_READ_URL` + pool separat în `lib/db.ts`) — azi nu există.
4. **Gestionat** când operarea devine costul principal: Azure Database for
   PostgreSQL Flexible (pgvector suportat) sau, pe Hetzner (fără Postgres gestionat),
   un furnizor extern (Aiven, Crunchy Bridge, Neon). Mutarea = `pg_dump`/`pg_restore`
   (ca la cutover) + schimbarea `DATABASE_URL`; nimic din cod.

Redis: dacă memoria/CPU-ul Redis concurează cu Postgres → mută `redis` pe un VM mic
separat (același `data.yml`, doar serviciul redis) sau Azure Cache / Upstash;
se schimbă doar `REDIS_URL`. Coada are nevoie de persistență (AOF) și
`maxmemory-policy` ≠ `allkeys-*`.

## 4. Echivalentul Hetzner

| Azure (acum) | Hetzner Cloud | Note |
|--------------|---------------|------|
| VNet 10.60.0.0/16 + subneturi | Cloud Network 10.60.0.0/16 cu subneturile 10.60.1/2/3.0/24 | IP-uri private statice la atașare |
| NSG per subnet | Hetzner Firewall per etichetă (`role=web/data/worker`) | aceleași reguli: fără inbound public; 5432/6379 doar din rețeaua privată |
| NAT Gateway | IP public pe web/worker cu firewall deny-all inbound; data fără IPv4 public → ieșire printr-un nod web ca gateway NAT (rută în Cloud Network) | sau IPv4 public + firewall, mai simplu |
| web: D2as_v5 (2 vCPU/8 GiB) | CPX21 / CX32 (4 vCPU/8 GiB) | shared vCPU; ~6–8 €/lună |
| data: E2as_v5 (2/16) + Premium SSD | CCX23 (4 vCPU dedicate/16 GiB) + Volume 100–200 GiB | cloud-init detectează volumul (`scsi-0HC_Volume_*`) |
| worker: D2as_v5 / D4as_v5 | CPX31 / CCX33 | ffmpeg preferă vCPU dedicate |
| Boot diagnostics / Run Command | Console web Hetzner / rescue | — |
| Buget Azure | alertă de cost în Hetzner Console | — |

Pași de migrare Azure → Hetzner: creezi serverele cu același `cloud-init.yaml` ca
*User data* (înlocuiești `__SWYPIK_ROLE__` și `__DEV_AUTHORIZED_KEY__`), pui env-urile
și `hosts.env` cu noile IP-uri, apoi urmezi exact §5–§8 din runbook-ul de cutover
(repetiție → mentenanță → dump/restore → comutarea conectorilor tunelului).
Cloudflare, R2 și aplicația nu se schimbă.
