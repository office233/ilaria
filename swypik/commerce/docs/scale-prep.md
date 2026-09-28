# Scale Prep — PgBouncer + Read Replica

## 1. PgBouncer (connection pooling)

Service `pgbouncer` adăugat în `infra/hetzner/docker-compose.prod.yml`. **NU este pornit.** Pași activare:

1. **Confirmă `POSTGRES_PASSWORD`** există în `.env.production` (folosit deja de postgres).
2. **Pornește serviciul** (doar pgbouncer, fără restart la celelalte):
   ```bash
   cd /opt/swypik/app
   docker compose -f infra/hetzner/docker-compose.prod.yml up -d pgbouncer
   docker compose -f infra/hetzner/docker-compose.prod.yml logs pgbouncer | tail -30
   ```
3. **Update `DATABASE_URL`** în `.env.production`:
   - Old: `postgres://swypik:PASS@postgres:5432/swypik`
   - New: `postgres://swypik:PASS@pgbouncer:6432/swypik`
4. **Prepared statements** — PgBouncer transaction mode NU suportă prepared statements named. Aplicația folosește `node-postgres` (`pg` v8) — prepared statements sunt OFF by default (folosim doar `pool.query(text, params)`, fără `PreparedStatement` object). **OK fără modificări.**
   - Dacă pe viitor introduci `pg-prepared` / `statement_cache`, dezactivează: `?statement_cache_mode=none` în URL sau client opts.
5. **Restart consumatorii DB** (web-next, cron-worker, video-worker):
   ```bash
   docker compose -f infra/hetzner/docker-compose.prod.yml up -d --force-recreate --no-deps web-next cron-worker video-worker platform-api
   ```
6. **Smoke**:
   - `curl https://swypik.com/api/health/db` → 200 `{status:ok}`.
   - `docker exec swypik-prod-pgbouncer-1 psql -h 127.0.0.1 -p 6432 -U swypik -d pgbouncer -c "SHOW POOLS;"`.

### Tuning ulterior
- `PGBOUNCER_DEFAULT_POOL_SIZE` (25) ≈ pool per (db,user). Cu 5 servicii × ~5 conexiuni active → 25 e suficient.
- `PGBOUNCER_MAX_CLIENT_CONN` (200) — top limit clienți simultani. Crește la 500+ când scali.

### ⚠️ Test pe staging înainte de prod
- Lansează un Postgres + PgBouncer local sau pe alt VPS.
- Rulează suite-ul de teste de integrare.
- Verifică că nu apar `PreparedStatement does not exist` errors în log.

---

## 2. Read replica (streaming replication)

**NU implementat.** Pași pentru viitor:

### Pe master (postgres primary)
`postgresql.conf`:
```
wal_level = replica
max_wal_senders = 5
max_replication_slots = 5
hot_standby = on
```

`pg_hba.conf`:
```
host replication replicator <REPLICA_IP>/32 scram-sha-256
```

```sql
CREATE USER replicator WITH REPLICATION ENCRYPTED PASSWORD '...';
SELECT pg_create_physical_replication_slot('replica1');
```

Restart master.

### Pe replica (VPS secundar Hetzner)
Provisione VPS dedicat (CCX23 sau echivalent) doar pt replica — izolat de app.

```bash
sudo -u postgres pg_basebackup -h <MASTER_IP> -D /var/lib/postgresql/data -U replicator -P -R -X stream -S replica1
```

`postgresql.auto.conf` (auto-generat de `-R`) va conține `primary_conninfo`. Start postgres → replica live.

Verifică: `SELECT * FROM pg_stat_replication;` pe master.

### App pattern (split read/write pools)
`lib/db.ts` extension propusă (**NU aplicat acum**):

```ts
import { Pool } from "pg";

const writePool = new Pool({ connectionString: process.env.DATABASE_URL });
const readPool = process.env.REPLICA_DATABASE_URL
  ? new Pool({ connectionString: process.env.REPLICA_DATABASE_URL })
  : writePool;

export const dbQuery = (text: string, params?: unknown[]) => writePool.query(text, params);
export const dbQueryRead = (text: string, params?: unknown[]) => readPool.query(text, params);
```

### Query-uri eligibile pt replica (SELECT-only, latency-tolerante)
- `app/api/explore/feed/route.ts` — feed pagination.
- `app/api/products/route.ts` — product listing.
- `app/api/search/*` — search.
- `app/api/categories/route.ts` — category list.
- `app/api/creators/[id]/route.ts` — creator profile read.
- `app/api/video/[id]/route.ts` — video metadata read.
- `app/api/products/[id]/reviews/route.ts` (GET) — reviews list.
- `app/api/v1/creator/[id]/*` — public creator endpoints.
- Toate paginile RSC care fac doar SELECT (`app/product/[id]/page.tsx`, `app/seller/[id]/page.tsx`, `app/explore/page.tsx` server fetch, etc.).

**NU eligibile** (write sau read-after-write):
- Cart, checkout, orders, auth, comments POST, like POST, follow POST.
- Notificări fetch (după write, vrei consistency).

### Replication lag monitoring
```sql
SELECT now() - pg_last_xact_replay_timestamp() AS lag;
```
Trigger alert dacă > 5s.

### ⚠️ Test pe staging înainte de prod
- Migrate la replica DOAR câteva endpoint-uri (start cu `/api/categories`).
- Verifică lag-ul în condiții de scriere intensă (upload video → check feed pe replica).
