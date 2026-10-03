# Mediu de lucru Swypik

**Local:** `E:\Meister\swypik\app` → **git** → **VPS** (178.105.46.66)

Nu se mai editează direct pe server. Fluxul e mereu: dezvolți local, verifici, faci push, apoi deployezi.

---

## 1. Pornire zilnică

```powershell
cd E:\Meister\swypik\app

# tunel către baza de date de dev (lasă-l deschis într-un terminal separat)
ssh -N -L 15433:localhost:5433 deploy@178.105.46.66

# în alt terminal
npm run dev          # http://localhost:3000
```

Prima dată completează parola bazei în `.env.local` (`DATABASE_URL`).
O găsești pe VPS: `grep DATABASE_URL /opt/swypik/app/infra/hetzner/.env.production`

---

## 2. Înainte de fiecare commit

```powershell
npm run typecheck    # trebuie 0 erori
npm run lint
npm run build        # prinde erorile care nu apar în dev
```

Sau tot lanțul: `npm run ci`

---

## 3. Commit și push

```powershell
git add -A
git commit -m "feat(modul): ce am făcut"
git push origin main
```

Mesajele de commit: `feat|fix|chore|refactor(zonă): descriere în română`

---

## 4. Deploy pe VPS

```powershell
ssh deploy@178.105.46.66 "cd /opt/swypik/app && git pull -q origin main && docker compose -f infra/hetzner/docker-compose.prod.yml -f infra/hetzner/docker-compose.vps.yml -f infra/hetzner/docker-compose.minio.yml --env-file infra/hetzner/.env.production up -d --build web-next"
```

Verificare după deploy:

```powershell
curl.exe -s https://swypik.com/api/health
curl.exe -s -o NUL -w "%{http_code}" https://swypik.com/
```

---

## 5. Migrații de bază de date

Scrii fișierul în `db/migrations/AAAALLZZ_NNNN_descriere.sql` (idempotent — `IF NOT EXISTS`, `ON CONFLICT DO NOTHING`).

**Întâi pe dev:**
```powershell
Get-Content db\migrations\FISIER.sql | ssh deploy@178.105.46.66 "docker exec -i swypik-prod-postgres-1 psql -U swypik -d swypik_dev"
```

**Apoi pe producție**, după ce ai verificat:
```powershell
scp db\migrations\FISIER.sql deploy@178.105.46.66:/tmp/m.sql
ssh deploy@178.105.46.66 "tr -d '\r' < /tmp/m.sql | docker exec -i swypik-prod-postgres-1 psql -v ON_ERROR_STOP=1 -U swypik -d swypik_prod"
```

> `tr -d '\r'` e obligatoriu — fișierele de pe Windows au CRLF și strică unele comenzi SQL.

---

## Capcane cunoscute

| Problemă | Soluție |
|---|---|
| PowerShell strică căile `app/[locale]/...` | Tratează `[id]` ca wildcard. Folosește Node pentru editări în acele fișiere. |
| Cheile/certificatele copiate cu `scp` nu merg | CRLF. Treci mereu prin `tr -d '\r'`. |
| nginx nu vede noul `nginx.conf` | Dacă fișierul a fost **înlocuit** (nu editat), Docker rămâne pe inode-ul vechi → `docker compose up -d --force-recreate nginx` + `docker network connect swypik-prod_default meister-nginx`. |
| Modificări la fișiere statice nu apar | Cache Cloudflare. Purge Everything sau `?v=2`. |

---

## Structură

| Cale | Ce conține |
|---|---|
| `app/api/` | 231 rute API |
| `lib/verticals/catalog.ts` | catalogul celor 32 de verticale (sursa de adevăr) |
| `lib/db.ts` | `dbQuery()` și `withTransaction()` |
| `lib/validation/schemas.ts` | toate schemele Zod |
| `db/migrations/` | migrații SQL, în ordine cronologică |
| `messages/*.json` | traduceri, 7 limbi |
