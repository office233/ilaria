# Swypik — Audit complet & Specificație tehnică de funcționare
> Data: 2026-08-01 · Audit pe 4 fronturi (infra, funcționalități, DB+economie, frontend)

---

# PARTEA I — CE ESTE SWYPIK

**Swypik este un super-app de comerț prin video** — un marketplace în care descoperirea produselor și serviciilor se face printr-un feed vertical de clipuri scurte (model TikTok), iar cumpărarea se întâmplă fără a părăsi videoclipul. În jurul acestui nucleu sunt construite verticale de servicii (mâncare, ride-hailing, travel, cazări, donații) și o economie proprie cu monedă internă (SWYP) ancorată într-un blockchain privat propriu (Swypik Chain).

**Modelul de business:** comision pe tranzacții (10% marketplace, 20% mobilitate, 5% comision creator pe vânzările generate din video), din care 10% din comisionul net alimentează fondul de acoperire al monedei SWYP.

**Actori:** Shopper (cumpărător) · Creator (face video, câștigă comision) · Seller (vinde produse) · Merchant (restaurant/magazin local) · Curier · Șofer (Go) · Gazdă (Stays) · Fleet partner (francize flotă) · ONG/Cauză · Admin.

---

# PARTEA II — ARHITECTURA TEHNICĂ

## 2.1 Stack
| Strat | Tehnologie |
|---|---|
| Frontend + API | Next.js 15 App Router, React, next-intl (7 limbi: ro/en/de/es/fr/it/pt), Tailwind (fără shadcn), PWA completă (manifest, SW, push, install prompt) |
| API Go | `services/platform-api` — Go 1.26, pgx/v5, port intern 8080 → VPS 127.0.0.1:8090 (admin/auth/checkout/creators/events/feed/marketplace/moderation/notifications/platform/social/users/videos) |
| DB | PostgreSQL 16 (port VPS 5433), ~65 migrări |
| Cache/queue | Redis 7 (streams `video:jobs`), Upstash pentru rate-limit |
| Storage | MinIO self-hosted (S3) + Cloudflare R2; CDN `cdn.swypik.com`, `media.swypik.com` |
| Video | video-worker Python+FFmpeg ×3 (HLS + thumbnail + preview), HLS.js în client |
| Live | mediamtx: RTMP :1935 ingest → HLS :8888, hooks spre `/api/internal/live/started` |
| Blockchain | geth Clique PoA, chainId 643366, bloc/5s, Blockscout explorer (scan.swypik.com), RPC public (rpc.swypik.com) |
| Plăți | Stripe (PaymentIntents, webhooks, Connect Express — flag OFF) |
| AI | OpenRouter/Gemini prin Cloudflare Worker proxy (`ai-chat-proxy.js`) |
| Observabilitate | pino JSON, Sentry (server 0.1 / client 0.05), `/api/health`, cron heartbeat, Grafana+ClickHouse (nefolosite activ) |
| Email | Resend/SMTP dual (chei neconfigurate încă) |

## 2.2 Securitate
- Sesiuni multi-rol pe cookie-uri separate (shopper/seller/admin/creator), CSRF origin-check pe metode mutante, TOTP 2FA (secret AES-256-GCM), bcrypt, rate-limit Upstash per-endpoint, audit log checkout, CSP + HSTS + security headers.
- RPC chain public are metodele periculoase blocate în nginx (`personal_*`, `admin_*`, `eth_sendTransaction`...).

## 2.3 Cron (worker dedicat, loop 60s, Bearer CRON_SECRET)
5min: publish-scheduled, refresh-rank, dispatch-tick, **scan-chain-deposits** · 10min: watchdog-videos · 15min: embed-batch, classify-pending · 30min: process-payouts · 1h: swyp-view-milestones, refresh-fx, alert-video-queue, aggregate-video-stats, fly-price-watch · 4h: abandoned-cart · 6h: detect-trends · zilnic: suspend-unverified, strikes-decay, cleanup-tokens, alert-dispute-deadlines, reconcile-wallets, battles/close, indexnow, bing-url-submit · săpt: email-digest.

---

# PARTEA III — FUNCȚIILE PLATFORMEI (și starea reală)

## 3.1 Video commerce / Feed — ✅ ~80%
Feed algoritmic (`/api/feed/universal`, recommendations, action/event tracking), interacțiuni video (like/view/save/share/comments/captions/products/report), explore fără cont, misiuni cu bounty, live streaming RTMP→HLS, dashboard creator.
**Lipsă:** personalizare pgvector în explore (TODO), validare env live streaming, rute dedicate battles/reels.

## 3.2 Marketplace — ⚠️ ~60%
Catalog + AliExpress dropship, coș guest+logat cu merge, checkout Stripe intent, comenzi, seller dashboard, API partener, cron dropship.
**Blocat:** Stripe Connect OFF (sellerii nu pot fi plătiți), returns OFF, fulfillment OFF → marketplace fără monetizare completă.

## 3.3 Food / Local — ⚠️ ~50%
local-orders, merchants CRUD, couriers (status/connect/earnings/payouts), dispatch engine cu valuri 2→5→10 km (dispatch-tick).
**Lipsă:** `/api/eats/` gol; `GET /api/merchants/[id]/orders` — restaurantul NU își vede comenzile; pagini `/market`, `/pharma` etc.

## 3.4 Go (ride-hailing) — ⚠️ ~70% backend, fără UI complet
rides + estimate server-side (pricing engine cu zone), status/pay/rating/stream/dispatch, fleet partners cu aprobare admin, founding drivers tiers.
**Lipsă:** pagina `/go` completă (fază târzie declarată).

## 3.5 Travel — ⚠️ ~40%
Fly: search (Duffel/Kiwi), deals, price-check, orders, price-watch cron. Stays: search/local/cities, availability GET, bookings, quote.
**Blocat:** `trips/packages` forțat `staysAvailable:false` până la activarea furnizorului; POST availability pentru gazde lipsește; bookings pe sloturi orare — schelet.

## 3.6 Social — 🔒 ~30% activ
Follow, notificări in-app, comments, likes, reports — merg. **DM (cu SSE stream) și Push — complete în cod dar OFF prin flag.**

## 3.7 Economia SWYP — ✅ ~90% (nucleul cel mai matur)
Detaliat în Partea IV. Mining, staking, rewards, plată hibridă, withdraw/transfer/deposit on-chain, rate/quote/supply/earn-rules — funcționale.

## 3.8 Donații/Cauze — ⚠️ ~30%
causes register, campaigns cu progres, donations — dar donațiile rămân `pending` fără Stripe, aprobarea cauzelor nu are UI admin, pagina publică `/cares` lipsește.

## 3.9 Admin — ⚠️ ~70%
25+ panouri există (users, videos, marketplace, moderation, orders, disputes, returns, reviews, sellers, creators, payouts, fleet, hosts, pricing, strikes, risk, refunds, commissions, finance, health, cron).
**Lipsă critică:** aprobare merchants, verificare curieri, aprobare donații → entitățile rămân blocate în `pending`.

## 3.10 Feature flags (toate OFF): dm, pushNotifications, stripeConnect, fulfillment, returns, emailMarketing, seoPages, aiChatFull. Activare: `FEATURE_<NAME>=1` + restart.

---

# PARTEA IV — ECONOMIA SWYP (specificație completă)

## 4.1 Principii
- **Supply fix**: 10 mld SWYP = 10¹² subunități (1 SWYP = 100 subunități intern; 18 zecimale on-chain). Zero emisie — totul pre-mintat în 5 pool-uri.
- **Orice mișcare = transfer** prin `swypTransfer()` (unica primitivă): idempotent pe `(ref_type, ref_id, kind)`, FOR UPDATE ordonat determinist, **hash-chain SHA256** per intrare (tamper-evident) sub advisory lock global.
- `tradable=false` — monedă internă, netradabilă extern (faza actuală).

## 4.2 Pool-uri (genesis, identic on-chain și în DB)
| Pool | % | Vesting |
|---|---|---|
| rewards | 55% | — |
| ecosystem | 15% | — |
| company | 15% | 48 luni |
| team | 10% | 48 luni + cliff 12 |
| reserve | 5% | — |

## 4.3 Mecanisme
- **Mining** (model Pi): sesiune 24h pornită manual, rată din `swyp_config`, halving la 10K/100K/1M/10M utilizatori, streak +10%/zi cap +100%, rată înghețată la start, plată idempotentă pe session_id.
- **Rewards**: reguli în DB (`swyp_emission_rules`) cu daily cap verificat pe ledger; anti-sybil: `requires_paid_tx` → obligatoriu `paidTxRef` (plată Stripe/comandă reală). Hooks best-effort după plăți/curse/livrări.
- **Curs RON/SWYP** = `backing_fund.balance_cents / Σ solduri utilizatori`. Fondul se alimentează EXCLUSIV cu 10% din comisionul net al platformei (`swyp_backing_pct`). Zero tranzacții → curs 0 (starea actuală, corectă).
- **Anti-bank-run**: fondul nu coboară sub 20% din valoarea de la începutul lunii la răscumpărări.
- **Plată hibridă**: SWYP acoperă max 50% din coș; subunitățile se întorc în pool rewards, contravaloarea RON iese din fond; idempotent.
- **Staking**: stake = transfer spre pool staking (scade circulația → crește cursul); bonus la scadență DOAR din surplusul lunar al fondului, pro-rata; retragere anticipată = principal da, bonus 0.
- **Refund**: cancel/fail → SWYP integral înapoi; charge.refunded → proporțional.

## 4.4 Swypik Chain + Bridge
- geth PoA (Clique), 1 validator, chainId 643366, bloc/5s, archive. Explorer Blockscout branduit (scan.swypik.com), RPC public cu landing page (rpc.swypik.com), metode periculoase blocate.
- **Portofel custodial per user**: cheie generată server-side, AES-256-GCM cu AUTH_SECRET, exportabilă oricând (self-custody opțional). „Add Swypik" în MetaMask din explorer.
- **Bridge complet (implementat azi 01.08):**
  - Withdraw: debit ledger intern (idempotent) → trezoreria REWARDS trimite on-chain → refund la eșec.
  - Transfer P2P: `/api/swyp/transfer` — semnat cu cheia userului, verificare sold+gas, jurnal `swyp_p2p_transfers`, rate-limit 5/5min.
  - Deposit: user trimite spre adresa trezoreriei → cron `scan-chain-deposits` (5min, cursor persistent, max 600 blocuri/rulare) → credit intern idempotent pe tx_hash.
  - Invariant: supply-ul intern rămâne constant (simetrie debit/credit).

---

# PARTEA V — CUM TREBUIE SĂ FUNCȚIONEZE COMPLET (fluxuri end-to-end țintă)

1. **Discovery→Purchase:** feed video → tap produs → drawer → coș → checkout Stripe (opțional hibrid SWYP max 50%) → comision 10% platformă + 5% creator → 10% din comision net → fond SWYP → hook awardSwyp cumpărătorului → seller plătit prin Stripe Connect (necesită flag ON) → livrare dropship/local → return window (flag ON).
2. **Creator:** urcă video (upload → Redis stream → FFmpeg HLS → CDN) → leagă produse → vânzări din video = comision 5% → payout prin Connect → fond creator lunar (de construit).
3. **Food:** comandă → merchant acceptă (panou care AZI LIPSEȘTE) → dispatch valuri curieri → tracking → livrare → decontare cu comision cash negativ permis în wallet.
4. **Go:** estimate server-side → comandă → dispatch șofer → cursă live (SSE) → plată → rating → 80% șofer / 20% platformă.
5. **Travel:** căutare Duffel/Kiwi + RateHawk → rezervare → price-watch → pachete fly+stay (necesită activare furnizori).
6. **SWYP lifecycle:** mining/cumpărături → sold intern → (retragere on-chain ↔ depunere înapoi) ↔ transfer P2P → plată hibridă → staking. Când fondul are bani reali, cursul devine pozitiv și răscumpărarea garantată.
7. **Trust:** email verificare (necesită chei Resend), strikes cu decay, moderare video, dispute, risk panel, reconciliere zilnică wallets.

---

# PARTEA VI — RISCURI & GAP-URI (prioritizate)

## 🔴 Critice
1. **Single VPS** — Postgres+Redis+MinIO+tot pe o mașină, fără replică/failover. Backup DB via systemd timer există; **MinIO fără backup** (video-urile se pierd ireversibil).
2. **Hot wallet trezorerie**: `SWYP_TREASURY_REWARDS_PK` în env pe serverul public — compromitere server = 5,5 mld SWYP furabili. (Backup GPG al cheilor există din 31.07, dar cheia activă rămâne hot.)
3. **Validator PoA unic** — un singur nod semnează; cade → chain-ul îngheață, withdraw-urile pică.
4. **Fără verificare invariant supply** — niciun cron nu confirmă `Σpool + Σuser = 10¹²`.
5. **Parolă MinIO hardcodată** în docker-compose.minio.yml.
6. **Monetizare blocată**: stripeConnect/returns/fulfillment OFF + email neconfigurat → marketplace-ul nu poate plăti selleri și nu trimite confirmări.

## 🟠 Majore
7. Hash-chain absent pe ledgerul RON (`wallet_ledger_entries`) — spre deosebire de SWYP, e modificabil fără detecție.
8. Panouri admin lipsă: merchants approve, curieri verify, donații — blochează onboarding-ul real.
9. `ChatInterface.tsx` monolitic + texte RO hardcodate în AI chat (6 limbi primesc română).
10. `swyp_backing_pct` și `swyp_emission_rules` editabile direct în DB fără audit trail — vector de inflație internă.
11. Redis fără persistență explicită; video-worker fără dead-letter queue.
12. CSP cu `unsafe-inline` pe script/style.

## 🟡 Medii
13. Manifest PWA duplicat (json + webmanifest); doi service workeri paraleli.
14. `/api/eats/` gol; pagini verticale lipsă (/go, /cares, /market...).
15. aria-labels netraduse; alt="" pe imagini produs; fără role="feed".
16. 1.135 `: any` în TS; teste automate aproape zero pe fluxurile critice.

---

# PARTEA VII — PLAN DE ACȚIUNE RECOMANDAT

**Sprint 1 — Siguranța banilor (1-2 zile):**
backup MinIO + parolă din env; cron verify-supply-invariant (Σ=10¹²) + alertă; hash-chain pe wallet_ledger_entries; audit trail pe platform_config/emission_rules; Redis AOF.

**Sprint 2 — Deblocare monetizare (2-3 zile):**
chei Resend (emailul e deja în lucru azi) → verificare conturi; Stripe live + Connect ON în test controlat; returns ON; panouri admin merchants/curieri/donații.

**Sprint 3 — Completare verticale (1 săpt):**
merchant orders API+panou; pagina /go; stays availability POST; /cares public; DM+push ON după test.

**Sprint 4 — Calitate (continuu):**
split ChatInterface + i18n AI chat; consolidare SW/manifest; teste vitest checkout/dispatch/swyp; al doilea validator PoA (sau măcar snapshot-uri chain); cold storage pentru cheile de trezorerie cu sume mari (company/team/reserve).
