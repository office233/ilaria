# Arhitectura Swypik

> Ultima actualizare: 2026-08-02. Public țintă: un inginer nou trebuie să înțeleagă proiectul în ~30 min. (Versiunea veche a acestui fișier descria o viziune „Go modular monolith" abandonată — realitatea de azi e mai jos.)

> ⚠️ **Infrastructură**: TOTUL rulează LOCAL în WSL (distro `swypik`, containere `swypik-prod-*`), expus prin Cloudflare Tunnel `swypik-home` → https://swypik.com. Web local: http://127.0.0.1:3005. VPS-ul vechi (178.105.46.66) este DEZAFECTAT.

## 1. Privire de ansamblu

Swypik = platformă de video commerce (TikTok-style feed + marketplace + servicii: zboruri, cazări, ride-hailing, food delivery) cu economie internă pe token SWYP (geth PoA privat, chainId 643366).

**Stack**: Next.js (App Router) + TypeScript, next-intl (7 limbi: ro, en, es, fr, de, pt, it), PostgreSQL 16 + pgvector, Redis, MinIO, Stripe, Cloudflare Realtime (SFU pentru Live, RealtimeKit pentru apeluri — `docs/infra/realtime.md`), Cloudflare Workers (ai, api-proxy, video), platform-api în Go, video-worker în Python (FFmpeg).

## 2. Servicii / containere (infra/hetzner/docker-compose.prod.yml + minio)

| Serviciu | Imagine | Port local | Rol |
|---|---|---|---|
| web-next | node:20.19-alpine (standalone) | 127.0.0.1:3005→3000 | aplicația Next.js |
| platform-api | golang:1.26 (build inline) | 127.0.0.1:8090→8080 | API Go auxiliar |
| postgres | pgvector/pgvector:pg16 | 127.0.0.1:5433→5432 | DB principal (~128 tabele) |
| redis | redis:7.4-alpine | intern | cache, cozi, rate-limit |
| video-worker ×3 | python:3.11-slim | — | pipeline FFmpeg (transcodare, thumbnails, captions) |
| cron-worker | shell custom | — | rulează cron-urile prin curl → /api/cron/* |
| minio | minio/minio | 9000/9001 | stocare S3 (video, imagini) |
| caddy, pgbouncer | — | — | **dezactivate** (`profiles: [disabled]`) — păstrate pentru scale-prep |

Servicii externe: Stripe (+Identity, Connect), Resend (email), Duffel/Kiwi (fly), RateHawk (stays), Gemini + GitHub Models (AI/moderare/embeddings), Cloudflare Workers, geth PoA (chain/).

## 3. Structura repo

```
app/               → App Router: pagini ([locale]/, admin/, seller/, creator/, auth/…) + api/
components/        → componente React pe domenii (auth, reels, live, checkout, i18n, pwa…)
lib/               → logică business: auth, db, payments, ai, video, feed/algo, swyp, rides, dispatch…
db/                → schema.sql + migrations/ (aplicare additivă)
services/          → platform-api (Go)
workers/           → video-worker (Python/FFmpeg)
chain/             → geth PoA privat, token SWYP
infra/hetzner/     → compose files, Caddyfile, cron-worker/run.sh, .env.production
messages/          → traduceri next-intl (7 limbi)
scripts/           → audituri (scan-hardcoded.mjs, audit-i18n.mjs), backup, check-env
tests/             → Playwright E2E
```

## 4. Rute API (~200) — grupuri și autentificare

| Grup | Protecție |
|---|---|
| `/api/auth/*`, oauth google/apple | publice prin design |
| `/api/cron/*` (~29 joburi) | `Authorization: Bearer CRON_SECRET` |
| `/api/admin/*` | sesiune admin (`requireAuth` cu rol admin) |
| `/api/internal/*` | header `INTERNAL_SECRET` |
| `/api/webhooks/stripe*` | semnătură Stripe (`STRIPE_WEBHOOK_SECRET`, `STRIPE_IDENTITY_WEBHOOK_SECRET`) |
| `/api/partner/*` | `PARTNER_PROVISION_SECRET` |
| `/api/health` public; `/api/health/full` | `INTERNAL_HEALTH_SECRET` |
| user-scoped: users/me, orders, cart, checkout, dm, push, seller, creator, couriers, rides, swyp | sesiune (cookie) via `lib/auth` / `lib/security/*` |
| publice read-only: products, search, explore, videos, fx, geo, `/api/v1/feed` | fără auth |

## 5. Cron-uri (infra/hetzner/cron-worker/run.sh)

Buclă la 60s; job rulează dacă `TICK % interval < 60`; `curl -m 300` per job, eșec izolat. La 5 min: publish-scheduled, refresh-rank, dispatch-tick, scan-chain-deposits. La 10 min: watchdog-videos, watchdog-rides. Restul (payouts, reconcile-wallets, email-digest, refresh-fx, cleanup-tokens, embed-batch, classify-pending, strikes-decay, abandoned-cart, indexnow, verify-supply, dropship etc.) la 30–1440 min — lista exactă în run.sh.

## 6. Baza de date

Schema în `db/schema.sql`, migrări additive în `db/migrations/`. Domenii: auth/sesiuni, marketplace (products/offers/variants/merchants), commerce (orders, commissions, payouts), video/media, social, live, wallet/SWYP (ledger, on-chain), moderare, dropship AliExpress (ae_*), creator (missions, collections), taxonomie, referral, notificări/push. Convenții: `docs/DATABASE_CONVENTIONS.md`.

## 7. Env vars

Sursa de adevăr runtime: `/opt/swypik/app/infra/hetzner/.env.production` (NU se comite, NU se suprascrie). `.env.example` ținut sincron cu codul — verificare cu `scripts/check-env*` și auditul din `docs/HARDCODE_AUDIT.md`.

## 8. Fluxuri critice (E2E)

1. Signup/login (email OTP + Google/Apple OAuth) → onboarding
2. Upload video → video-worker FFmpeg → publish → feed rank
3. Shop: product → cart → checkout Stripe → order → commission → payout
4. SWYP: earn → wallet → on-chain deposit/withdraw (scan-chain-deposits, verify-supply)
5. Live: browserul gazdei → Cloudflare Realtime SFU (prin /api/live/streams/[id]/publish) → heartbeat → live; spectatorii trag prin /watch; chat + produse fixate pe SSE
6. Go (rides): estimate → request → dispatch-tick → watchdog-rides
7. Food: restaurant → order → courier dispatch
8. Fly/Stays: search (Duffel/Kiwi/RateHawk) → booking
9. Seller: apply → admin approve → dashboard → products → payouts

## 9. Deploy

Local WSL: `cd /opt/swypik/app && git pull && docker compose -f infra/hetzner/docker-compose.prod.yml up -d --build web-next` (sau serviciul modificat). Verificare: `curl -s http://127.0.0.1:3005/api/health` + curl pe https://swypik.com. Detalii: `docs/LOCAL_DEVELOPMENT.md`, runbook-uri în `docs/`.
