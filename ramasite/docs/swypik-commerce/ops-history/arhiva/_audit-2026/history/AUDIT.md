# AUDIT Swypik — 2026-08-24

Auditor: Claude Code (misiune: build curat, aplicație funcțională, cod mai curat).
Branch de lucru: `fix/audit-swypik` (în ambele repo-uri).

## 1. Structura workspace-ului (`E:\Swypik`)

| Componentă | Ce este | Stack | Git |
|---|---|---|---|
| `multi-erp/` | ERP multi-tenant (Meister ERP v4 → platformă franciză Swypik) | Go 1.24+ (chi, pgx, sqlc) backend + React 19/Vite/TS frontend + Postgres + Docker | repo propriu, branch activ `recover/audit-20260803`, remote `origin` (GitHub) + `vps` |
| `swypik/app/` | Platformă social-commerce (TikTok-Shop style), swypik.com | Next.js 15 (App Router) + TS + Tailwind + pg + Stripe + R2; Go `services/platform-api` | repo propriu, branch `main` (ahead 1 de origin); **CLAUDE.md spune că sursa de adevăr e VPS-ul, branch prod `mvp-freeze`** |
| `_docs-meister/` | Documente de audit/recuperare anterioare (AUDIT-360, RAPORT_BUG_HUNT, RECUPERARE-multi-erp-23aeb03) | — | — |
| `smoke.sh` | Smoke test HTTP pe rute publice swypik/app (port 3005) | bash | — |
| `_tmp/`, `8`, `wsl-keepalive.*`, `.playwright-mcp/` | Utilitare/reziduuri locale | — | — |

Dimensiuni: backend Go ≈ 105k LOC (45 module), ERP frontend ≈ 73k LOC (39 module), swypik/app ≈ 51k LOC (~101 rute API).

## 2. Context istoric important

- Commit-ul `23aeb03` („capture /opt prod state as baseline") a suprascris repo-ul multi-erp cu starea de pe VPS și a pierdut 681 linii de fix-uri (documentat în `_docs-meister/RECUPERARE-multi-erp-23aeb03.md`).
- Branch-ul `recover/audit-20260803` (activ azi, ultimul commit 2026-08-24 16:30) restaurează acele fix-uri: izolare tenant (F-01..F-18), JWT fail-fast, eliminare hardcodări Meister. **Acest branch e baza auditului curent.**
- `D:\Swypik` este o copie mai veche a workspace-ului (multi-erp pe `main`); sursa activă e `E:\Swypik` (mutarea pe E: e commit-ul de azi din swypik/app).

## 3. Entry points & fluxuri principale

### multi-erp
- Backend: `backend/cmd/server/main.go` → chi router, module montate sub `/api/*`; middleware `pkg/middleware/auth.go` (JWT HS256 + tenant_id fail-closed).
- Frontend ERP: `frontend/src/main.tsx` → module lazy-loaded per pagină (dashboard, pos, finance, warehouse, deliveries, crm, loyalty…), state cu zustand, API prin `shared/api.ts` (axios + interceptor auth).
- DB: Postgres, migrări în `database/`; sqlc generează `backend/internal/db`.
- Deploy: docker-compose (local WSL `/opt/multi-erp`), țintele VPS din Makefile sunt DEPRECATED.

### swypik/app
- Next.js App Router: `app/` (explore/feed video, checkout Stripe, seller, creator, admin, courier), API în `app/api/**/route.ts`, DB raw SQL prin `lib/db.ts`.
- `services/platform-api` (Go): upload video creator, proxy prin Caddy — ACTIV.
- Feature flags în `lib/feature-flags.ts` (DM, push, Stripe Connect etc. OFF în prod).

## 4. Baseline verificat (înainte de orice modificare, 2026-08-24)

| Verificare | Rezultat |
|---|---|
| `go build ./backend/...` (multi-erp) | ✅ curat |
| `go test ./backend/...` | ✅ toate trec (testele de integrare cu DB se skip fără `MEISTER_TEST_DB_URL`) |
| ERP frontend `npm run build` (tsc -b + vite) | ✅ curat (warning chunks >500kB) |
| ERP frontend `npm run test` (vitest) | ✅ 287/287 |
| ERP frontend `npx eslint .` | ⚠️ **2 erori** + 576 warnings — `fleet/FleetPage.tsx:48` (hook condiționat), `simple/SimpleProducts.tsx:51` (expresie moartă) |
| swypik/app `tsc --noEmit` | ✅ curat |
| swypik/app `next build` | ✅ curat |
| swypik/app `vitest run` | ✅ 116/116 |
| swypik/app `next lint` | ⚠️ 0 erori, multe warnings (`no-explicit-any`, unused vars) |

## 5. Mediu de rulare local

- Stack-ul rulează deja în WSL (distro `swypik`) prin Docker: **swypik/app pe `127.0.0.1:3005`** (healthy: DB+Redis+R2 ok; build `d8b42f55` din 2026-08-19 — mai vechi decât HEAD-ul local) și **ERP multi-erp pe `127.0.0.1:8091`** (healthy, v4.0.0). Comenzile `wsl -e`/`docker` nu sunt accesibile din shell-ul acestei sesiuni, deci nu pot redeploya containerele — verificarea funcțională se face pe instanțele care rulează.
- Smoke test inițial (`smoke.sh` pe :3005): totul 200/307 cu excepția `404 /products` și `404 /voice` — ambele rute nu mai există în cod (`app/[locale]/product` e singular; `voice` a dispărut) ⇒ smoke.sh e învechit la aceste 2 intrări.
- swypik/app: regula proiectului din CLAUDE.md e „edit numai pe VPS"; auditul local lucrează pe branch separat, fără push/deploy.
- Makefile multi-erp referă `storefront/` care **nu există** în repo → țintele `build`/`test` din Makefile eșuează (build-ul real, direct, merge).

## 6. Constatări — completate după Fazele 1–2 (vezi RAPORT.md pentru lista finală)
