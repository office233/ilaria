# Swypik — Social Commerce Platform

> **Hosting (28.09.2026):** producția rulează pe Azure (`rg-swypik-prod`, swedencentral).
> Hostingul WSL de pe PC-ul de acasă și Multi-ERP (erp.swypik.com, repo swypik-multi-erp)
> sunt retrase definitiv — nu le folosi și nu restaura copii WSL peste Azure. Instrumentul
> sellerului este panoul nativ `/seller`. Stare și blocaje de lansare:
> `docs/audits/2026-09-27-azure-readiness.md`.

## Descriere
Swypik = platforma social commerce (TikTok Shop style) care combina video-uri scurte cu cumparaturi. Useri descopera produse prin video-uri, creatorii castiga comisioane, sellerii gestioneaza catalog importat din AliExpress.

## Tech Stack
- **Frontend:** Next.js 14 (App Router) + TypeScript + TailwindCSS + next-themes (dark mode)
- **Backend API:** Next.js API Routes (`app/api/`)
- **Platform API:** Go service la `services/platform-api/` — ACTIV pentru creator video upload (port 8090, `api.swypik.com`)
- **Database:** PostgreSQL 16 pgvector (Docker, `swypik-postgres` pe VM-ul data)
- **Cache:** Redis 7 (Docker, `swypik-redis` pe VM-ul data; și coada video)
- **Storage:** Cloudflare R2 (bucket `swypik-prod-media`; backup-uri în `swypik-prod-backups`)
- **Payments:** Stripe (Checkout Sessions + Webhooks)
- **AI:** Azure AI Foundry (EU Data Zone, platit din creditele Azure) — un singur modul `lib/ai/azure/*`: chat `AZURE_OPENAI_CHAT_DEPLOYMENT` (gpt-5.4-mini, structured output), Whisper (subtitrari, si in `workers/video-worker`), Content Safety (moderare text + imagine, praguri `CONTENT_SAFETY_*`). Fara alti furnizori (GitHub Models / OpenRouter / Gemini eliminati 2026-09-26); StudiAI ramane doar in scripturile offline `scripts/data`, `scripts/eval`.
- **Edge:** Cloudflare Tunnel `swypik-azure` (`cloudflared-swypik`, câte un conector pe fiecare VM web) → `http://localhost:3005` (web-next) / `:8090` (platform-api). Fără Caddy.
- **Deploy:** Docker Compose pe VM-uri Azure, prin `infra/azure/deploy.sh` rulat de pe web-1

## Hosting (Azure, din 27.09.2026)
- **VM-uri** (`rg-swypik-prod`, swedencentral, fără IP public; ieșire prin NAT Gateway):
  - `web-1` 10.60.1.10 — web-next, platform-api, cloudflared, **cron-worker** (doar aici), nod de control pentru deploy;
  - `web-2` 10.60.1.11 — web-next, platform-api, cloudflared;
  - `data` 10.60.2.10 — Postgres 16 pgvector (`swypik-postgres`) + Redis 7 (`swypik-redis`), disc `/srv/data`;
  - `worker` 10.60.3.10 — video-worker (consumă coada Redis → ffmpeg → R2).
- **Infra ca cod:** `infra/azure/` — `main.bicep`, `cloud-init.yaml`, `compose/{web,data,worker}.yml`, `deploy.sh`, `preflight.sh`, `node/*.sh`, `backup-db.sh`. Runbook: `docs/infra/azure-cutover.md`.
- **Env:** `/opt/swypik/env/swypik.env` (copiat de deploy pe web + worker), `data.env` pe nodul data, `hosts.env` pe web-1. Validare: `infra/azure/preflight.sh`.
- **DB:** user `swypik`, db `swypik_prod`; migrările aplicate sunt în `schema_migrations(version = nume fisier fara .sql)`.
- **GitHub:** `https://github.com/office233/swypik-commerce-platform.git`, branch principal `main`.
- **Live:** https://swypik.com

## Workflow
1. Editezi in `E:\Swypik\swypik-commerce-platform` (sau într-un worktree al lui), pe branch de feature; gate-uri: `npx tsc --noEmit --incremental false`, `npx vitest run`, `npx next lint`, `node scripts/i18n-guard.mjs`, `npx next build`.
2. Merge in `main` + `git push origin main`.
3. Deploy: GitHub Actions **Deploy production** (OIDC, fără chei locale — `docs/infra/github-deploy.md`), sau manual pe web-1: `sudo -iu dev bash /opt/swypik/app/infra/azure/deploy.sh [--flags "FEATURE_X ..."] [--services "video-worker cron-worker"]`.
   Face: lock, clonă curată + `git pull --ff-only`, preflight env, release pe noduri, backup DB pe nodul data,
   migrările noi o singură dată, build o dată pe web-1, rolling pe nodurile web (health cu noul commit, rollback automat per nod), smoke.
   Nu se copiaza NICIODATA fisiere locale in productie.

GitHub `main` = sursa de adevar; `/opt/swypik/app` pe web-1 e doar clona de rulare.

## Structura reala (post Val 3)
```
/opt/swypik/app/
├── app/                          # Next.js App Router
│   ├── api/                      # 101 route.ts files
│   │   ├── auth/                 # OTP email + sessions
│   │   ├── v1/feed/              # Feed ranking (cu seen_video_ids LRU)
│   │   ├── feed/events/batch/    # Tracking events (30+ tipuri)
│   │   ├── products/             # CRUD catalog
│   │   ├── checkout/             # Stripe Checkout
│   │   ├── webhooks/stripe/      # Stripe webhooks
│   │   ├── upload/session/       # Video upload (Go platform-api)
│   │   ├── chat/                 # AI chat (FEATURE_AI_CHAT_FULL)
│   │   ├── creator/              # Creator dashboard
│   │   ├── seller/               # Seller portal
│   │   ├── admin/                # Admin panel
│   │   ├── dm/                   # FROZEN (FEATURE_DM=0)
│   │   ├── push/                 # FROZEN (FEATURE_PUSH_NOTIFICATIONS=0)
│   │   ├── stripe-connect/       # FROZEN
│   │   ├── fulfillment/          # FROZEN
│   │   ├── returns/              # FROZEN
│   │   └── email-marketing/      # FROZEN
│   ├── explore/                  # Video feed
│   ├── movies/                   # Swypik Movies: catalog, serial, player (FEATURE_MOVIES)
│   ├── music/                    # Swypik Music: artisti, piese/albume, mini-player persistent (FEATURE_MUSIC)
│   ├── record/                   # Camera page (MediaRecorder, Val 3)
│   ├── account/                  # User profile + ThemeToggle
│   ├── checkout/success/         # cu PurchaseTracker
│   ├── seller/                   # Seller dashboard
│   ├── admin/                    # Admin panel
│   └── layout.tsx                # cu ThemeProvider
├── components/
│   ├── BottomNav.tsx             # 5 items: Acasa, Explore, Record, Inbox, Profil
│   ├── ProductFeed.tsx           # Feed + Raport button + sendFeedEvent
│   ├── ChatInterface.tsx         # AI chat full UI
│   ├── ThemeProvider.tsx         # next-themes wrapper
│   ├── ThemeToggle.tsx           # cycles dark/light/system
│   ├── PurchaseTracker.tsx       # fires purchase event la /checkout/success
│   └── ...
├── lib/
│   ├── ai/
│   │   ├── azure/                # Azure AI Foundry: chat, whisper, content-safety, embeddings
│   │   ├── moderate.ts           # Content Safety pe text (publicare video) → moderation_cases
│   │   └── moderation.ts         # filtru pe ieșirea chatului de shopping
│   ├── feed/
│   │   └── track.ts              # batched sendBeacon emitter
│   ├── movies/                   # acces/pret (pure), unlock cu cardul (Stripe, RON) + cota creator, proxy HLS cu token
│   ├── music/                    # acces/pret (pure), unlock cu cardul (Stripe, RON), publish + sincronizare audio_tracks pentru reels
│   ├── media/                    # stream-token/path/secret, hls-rewrite — comun Movies + Music
│   ├── feature-flags.ts          # 8 flags (DM, push, AI chat, etc)
│   ├── feature-flags-client.ts   # client-side variant
│   ├── haptic.ts                 # navigator.vibrate wrapper
│   ├── social/
│   │   ├── session.ts            # getOptionalSocialUserId
│   │   └── proxy.ts              # → platform-api
│   ├── auth/getAuthUser.ts
│   ├── db.ts                     # pg Pool
│   ├── stripe/                   # Stripe SDK
│   ├── storage/                  # R2 client
│   └── ...
├── services/
│   └── platform-api/             # Go (ACTIV, NU sterge)
├── db/migrations/                # SQL migrations, numerotate strict
├── infra/azure/                  # productie: bicep, cloud-init, compose per rol, deploy.sh, preflight.sh
├── infra/hetzner/
│   └── docker-compose.prod.yml   # folosit de deploy.sh doar pentru build-ul imaginilor
├── scripts/data/                 # traduceri/clasificari offline (StudiAI, nu runtime)
└── workers/ (in lucru, era services/video-worker/)
```

## Baza de Date (Postgres)
- 79 tabele in `public` schema
- **Auth unified:** `users` (12, are coloana `role` shopper/creator/seller/admin) + `sellers` (entitate business separata) + `user_sessions`/`seller_sessions`. `lib/auth/getAuthUser.ts` = facade unic cu `requireRole()`. `customer_sessions` + `auth_accounts` = deprecated/dormant.
- **Catalog:** `marketplace_products` (14012), `ae_products` (14012), `ae_categories`, `ae_variants`
- **Video:** `videos` (4752), `creator_videos` (0), `video_assets`, `video_processing_jobs`, `video_upload_sessions`
- **Feed/Discovery:** `feed_events` (30+ event types), `user_feed_state` (seen_video_ids jsonb LRU max 500), `feed_items`, `user_interests`, `user_hidden_videos`
- **Topics taxonomy (Val 3):** `topics` (20 seeds), `product_topics`
- **Commerce:** `commerce_orders` (6), `commerce_order_items`, `carts`, `cart_items`, `commissions`, `commission_payouts`
- **Adult gating (Val 3):** `user_age_verifications`, `users.birth_date`, `users.age_verification_status`, `users.adult_content_opt_in`
- **Moderation:** `moderation_cases`, `moderation_reports`, `moderation_actions`
- **Tracking:** `schema_migrations` (version, applied_at) — strict numerotate `YYYYMMDD_NNNN_*`

### Conectare DB
```bash
# pe VM-ul data
docker exec -it swypik-postgres sh -c "psql -U \$POSTGRES_USER -d \$POSTGRES_DB"
```

## Feature Flags
Toate gated prin `lib/feature-flags.ts` (server) + `feature-flags-client.ts` (client):

| Flag | Status prod | Note |
|---|---|---|
| `FEATURE_DM` | OFF | Routes intoarce 410 |
| `FEATURE_PUSH_NOTIFICATIONS` | OFF | |
| `FEATURE_STRIPE_CONNECT` | OFF | |
| `FEATURE_FULFILLMENT` | OFF | |
| `FEATURE_RETURNS` | OFF | |
| `FEATURE_EMAIL_MARKETING` | OFF | |
| `FEATURE_SEO_PAGES` | OFF | |
| `FEATURE_AI_CHAT_FULL` | OFF | Necesita `AZURE_OPENAI_*` in `swypik.env` |
| `FEATURE_CARES` | OFF | Swypik Cares (donatii, `/cares`, `/cauze`, `/api/donations|campaigns|causes`) — pana exista un partener ONG (+ `NEXT_PUBLIC_FEATURE_CARES`). Squad Buy si App Store/Developers au fost sterse 2026-09-26 (tabelele raman) |
| `FEATURE_VIRAL_CATALOG` | OFF | Catalog demo de produse (date de exemplu) |
| `FEATURE_MOVIES` | OFF | Swypik Movies (+ `NEXT_PUBLIC_FEATURE_MOVIES`); migrarea `20260921_0003_movies.sql`; spec in `docs/superpowers/specs/2026-09-21-swypik-movies-design.md` |
| `FEATURE_MUSIC` | OFF | Swypik Music (+ `NEXT_PUBLIC_FEATURE_MUSIC`); migrarea `20260922_0001_music.sql`; spec in `docs/superpowers/specs/2026-09-21-swypik-music-design.md` |
| `FEATURE_NEWS` | OFF | Swypik AI News (+ `NEXT_PUBLIC_FEATURE_NEWS`); necesita `AZURE_OPENAI_*` (+ optional `NEWS_AI_DEPLOYMENT`) |
| `FEATURE_GAMING` | OFF | Swypik Arcade (+ `NEXT_PUBLIC_FEATURE_GAMING`) |
| `FEATURE_MESSENGER` | OFF | Swypik Messenger — mesaje & apeluri video (+ `NEXT_PUBLIC_FEATURE_MESSENGER`); apelurile audio/video (Cloudflare RealtimeKit) necesita `CF_REALTIMEKIT_*` + `NEXT_PUBLIC_CALLS_ENABLED=1` (vezi `docs/infra/realtime.md`) |

Crypto/SWYP eliminat 2026-09-25 pentru eligibilitate NVIDIA Inception — tabelele DB rămân, neutilizate.

Toate flag-urile de mai sus sunt OFF implicit (opt-in explicit). Pentru module noi
(`movies`/`music`/`news`/`gaming`/`messenger`), perechea `FEATURE_X` +
`NEXT_PUBLIC_FEATURE_X` trebuie setata AMBELE la BUILD TIME (`deploy.sh --flags`
le scrie pe amandoua in `swypik.env` inainte de build, nu doar la
runtime) — altfel paginile index prerandate si bundle-ul de browser raman
"ascunse" chiar daca flag-ul server e pornit (vezi comentariul din
`lib/feature-flags-client.ts`).

## Containere Docker (prod, Azure)
- web-1/web-2: `swypik-web-web-next-1` (Next.js, :3005), `swypik-web-platform-api-1` (Go, :8090); doar web-1: `swypik-web-cron-worker-1`
- data: `swypik-postgres` (Postgres 16 pgvector), `swypik-redis` (Redis 7)
- worker: video-worker (Python FFmpeg pipeline, compose `infra/azure/compose/worker.yml`)

## Conventii cod
- TypeScript strict mode (in lucru, 268 `: any` raman, vezi Faza 6)
- TailwindCSS dark mode `class` strategy (next-themes)
- API routes: `app/api/[resource]/route.ts` (GET/POST/PUT/DELETE)
- DB: raw SQL prin `lib/db.ts` dbQuery (pg Pool), NU ORM
- Auth: cookie-based sessions cu SHA-256 hashed tokens
- Logging: `lib/logger.ts` (in propagare, raman 69 `console.log`)
- Env vars: NUMAI in `/opt/swypik/env/swypik.env` pe VM-uri (model: `.env.example`)

## REGULI IMPORTANTE
1. **EDIT in `E:\Swypik\swypik\app`**, deploy doar din git prin `infra/azure/deploy.sh` pe web-1 — vezi Workflow
2. **NU modifica `swypik.env` direct** — cere confirmare (exceptie: flag-urile unei lansari aprobate explicit)
3. **Migration files**: numerotate strict `YYYYMMDD_NNNN_descriere.sql`, recorded in `schema_migrations`
4. **NU sterge tabele/coloane** fara backup `pg_dump`
5. **Mobile-first design** — UI optimizat pentru mobil (BottomNav 5 items)
6. **Deploy:** numai `infra/azure/deploy.sh` (rolling, un nod web pe rand)
7. **Azure AI Foundry** (`lib/ai/azure`) pentru tot AI-ul — nu reintroduce GitHub Models / OpenRouter / Gemini
8. **Go platform-api** este ACTIV — nu sterge

## Fluxuri principale
1. **Discovery:** `/` → `/explore` (video feed cu seen_video_ids LRU) → swipe → tap product → `/checkout` Stripe
2. **Creator:** apply → upload video via `app/api/creator/upload-session` (→ platform-api Go) → comision la vanzari
3. **Seller:** dashboard → import AliExpress → catalog → orders
4. **Admin:** `/admin` → login cu contul propriu (`users.role=admin`, OTP) → sesiune de admin personală 12h, roluri `users.admin_role` (owner/ops/finance/moderator/support, `lib/admin/permissions.ts`), meniu din `lib/admin/nav.ts`, audit în `admin_audit_log` (`/admin/audit`). `ADMIN_SECRET` = doar Bearer pentru scripturi/cron (+ acces de urgență cu `ADMIN_BREAK_GLASS_ENABLED=1` și emailul unui admin)
5. **AI chat:** `/chat` → Azure OpenAI (structured output) → Content Safety pe raspuns

## TODO restant (per plan Faza 0-6, 2026-05-14)
- ✓ Faza 0 Backup (mvp-freeze pushed)
- ✓ Faza 1 Junk cleanup
- ✓ Faza 2 Go decision (PASTREAZA)
- ✓ Faza 5 CLAUDE.md sync (acest commit)
- ⏳ Faza 3 Folder reorg (route groups marketing/shop/account/seller/admin)
- ✓ Faza 4 Auth unified (deja era, doar backfill 2 customers + docs sync)
- ⏳ Faza 6 Code quality (logger propagation, type strict)

## URL-uri Production
- Site: https://swypik.com
- API: https://swypik.com/api/*
- Sitemap: https://swypik.com/sitemap.xml
