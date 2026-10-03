# Backlog — Swypik

> Actualizat 2026-09-29. Prioritizare: P0 = risc financiar/securitate, P1 = important, P2 = nice-to-have.

## Audit extern runda 2 (2026-08-03) — rămase conștient P1–P3

| # | Problemă | Fișier | Sev. | Justificare amânare |
|---|---|---|---|---|
| 1 | **OBSOLET** — vechiul P2P on-chain `/api/swyp/transfer` | runtime eliminat | — | Ruta și `lib/swyp` nu mai există. Redeschidem doar dacă produsul SWYP on-chain revine. |
| 2 | **OBSOLET** — vechiul scanner SWYP deposits | runtime eliminat | — | `lib/swyp/deposits.ts` nu mai există. |
| 3 | **OBSOLET** — vechiul `swypTransfer` din staking | runtime eliminat | — | `lib/swyp/staking.ts` nu mai există. |
| 4 | Datorie cash șofer nu scade referralDiscount | `lib/payments/mobility.ts:166` | P2 | Decizie de produs necesară (cine suportă discountul); contabilitatea actuală e conservatoare pentru platformă. |
| 5 | Comentarii contradictorii referral (2% vs 50%) | `lib/drivers/referral.ts:11` | P2 | Doar documentație; valorile reale sunt constantele. |
| 6 | **OBSOLET** — vechiul SWYP mining status | runtime eliminat | — | `lib/swyp/mining.ts` nu mai există. |
| 7 | Rate-limit fallback în memorie fără Redis | `lib/security/rate-limit.ts:80` | P2 | Producția ARE Redis configurat; riscul e doar la misconfig. |
| 8 | **OBSOLET** — dust deposits SWYP | runtime eliminat | — | Modulul deposits nu mai există. |
| 9 | **OBSOLET** — parsing vechi `amountSwyp` | runtime eliminat | — | Ruta transfer nu mai există. |
| 10 | **OBSOLET** — explorer URL în rutele SWYP vechi | runtime eliminat | — | Rutele `app/api/swyp/*` nu mai există. |
| 11 | aria-label RO/EN hardcodate (ChatInterface, ProductFeed, MobileDashboardNav, VerifiedBadge, VideoSection, colecții) | diverse | P2-P3 | Fix mecanic în lot separat; nu blochează fluxuri. |
| 12 | `fmtLei` alias derutant în MenuClient | `MenuClient.tsx:209` | P3 | Redenumire cosmetică. |

## Securitate (din docs/SECURITY_AUDIT.md)

- [x] **P0 S1** — `POST /api/videos/[id]/view`: dedupe persistent rolling-24h pe user/anon first-party + bridge anon→user; IP/Redis rămâne doar anti-abuz. Migrare `20260929_0007_video_view_dedupe.sql`.
- [x] **P0 S2** — `POST /api/v1/events{,/batch}`: actorul este legat server-side de `swypik_session`; anonimii primesc session pseudonimizat din `swypik_anon`; body-ul nu mai poate seta userId/actorId autoritativ. Rate-limit IP + identitate și batch max 50.
- [x] **P1 S3** — `local-orders/[id]/status`: 401 explicit când requesterul nu e nici seller nici curier; 403 păstrat pentru rol valid dar actor greșit pe tranziție.
- [x] **P1 S4** — `notifications/subscribe` DELETE: revocarea este limitată atomic la `endpoint + user_id`; test de regresie dedicat pentru ownership.
- [x] **P1 S6** — Fly provider-cost protection: search/price-check au rate-limit per IP + per user/anon first-party; căutările identice au cache scurt + single-flight, iar checkout-ul păstrează live price-check obligatoriu.
- [x] **P2 S7–S10** — S7 AI chat bounded + IP/identity + minute/day AI quota; S8 video event folosește eligibilitatea canonică, feedback verifica deja existența; S9 product like/share verifică existența; S10 `order_lookup_token` = 24 bytes CSPRNG (192-bit), generator/test dedicat.
- [x] **P2** — Admin fulfillment folosește union Zod strict pe acțiune; `/v1/events` validează Zod fiecare event + metadata înainte de compat normalization; `ChatPostSchema` este bounded/typed.

## Funcțional (din AUDIT-E2E-2026-08-02)

- [ ] **P1 extern — Shopify one-click launch**: codul OAuth/refresh/webhooks/bootstrap este implementat în `swypik.com/seller`; pentru live trebuie creată/publicată aplicația oficială Shopify „Swypik”, configurate `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET`, callback-ul `https://swypik.com/api/seller/integrations/shopify/callback`, compliance webhooks și Public distribution cu Limited visibility. Pentru istoric mai vechi de 60 zile: aprobare separată Shopify pentru `read_all_orders`. Sellerii NU configurează tokenuri/webhooks individual; fiecare își autorizează propriul shop din butonul Swypik.
- [ ] **P0 mediu** — Chei Stripe reale de TEST în `.env.production` WSL (`sk_test_`/`pk_test_`+webhook): acum `sk_placeholder` → plăți indisponibile. După setare: rebuild web-next (pk e build-arg) + test plată 4242 4242 4242 4242 (jurnal P3).
- [x] UX feed cart: eroarea API produce toast, iar ProductFeed afișează „Added” și trimite event-ul add_to_cart numai după confirmarea reală a serverului; listing-urile/variantele necumpărabile nu mai arată succes fals.
- [x] PWA update lifecycle: SW URL versionat per build, `updateViaCache:none`, `registration.update()`, `skipWaiting+clients.claim`, no-cache pe `/sw.js` și reload automat o singură dată la `controllerchange`.
- [x] `/reels/record` fără cameră: `CameraCapture` oferă deja fallback explicit „Use Gallery” pentru denied/unavailable și revine în picker-ul aceluiași CreateFlow.
- [x] Video-uri orfane „AȘTEPTARE”: watchdog-ul marchează failed/private/hidden uploadurile >6h fără job și fără sesiune reluabilă activă; expiră separat uploadurile multipart abandonate.
- [ ] Battles — zero cod backend, doar UI. Decizie: implementare sau eliminare UI.
- [ ] Fluxuri parțiale de finalizat (Faza 5): Food, Stays, Go, Live, Missions, Seller.
- [x] Rate-limit Redis pe search public: search/audio/Fly/Geo/Stays aveau deja limiter; `/api/search/suggest` a fost aliniat la bucket-ul distribuit `suggest`.
- [ ] Chat live + tips în live, CDN cache headers, email la seller approve (nice-to-have din prompt).

## i18n / UI

- [x] Explore auth UX: like video este permis anonim; save face rollback + redirect la login pe 401; follow folosește auth redirect și toast pentru celelalte erori.

## Curățenie (Faza 4 — din docs/DEAD_CODE.md)

- [ ] Componente/rute neimportate (rulează `scripts/audit-dead-code.mjs`).

## Audit extern Valul 4 (2026-08-03) — triaj rămase P2/P3

Fixate imediat (commit f21306db): P0 credit gazdă eșuat→reconciliation_issues (wallet+Stripe), P1 race dublu-pay stay booking, P2 preț client-controlled în coș.

| Sev | Găsire | Fișier | Justificare amânare |
|---|---|---|---|
| FIXAT | Moderation visibility uniformă | feed/profil/search/video overlay | Auto-moderation este activă implicit; trigger-ul DB mapează pending/rejected/adult/blocked în `effective_label != 'safe'`. Suprafețele publice folosesc poarta canonică `effective_label='safe'`; overlay-ul de produs a fost aliniat în această rundă. |
| FIXAT | Donations money parsing exact | app/api/donations/route.ts, lib/money/decimal.ts | Suma este validată decimal exact și transformată în `amount_cents` în schema Zod; >2 zecimale sunt respinse, fără `Math.round(float*100)`. |
| FIXAT | Live creator identity canonic UUID | app/api/live/streams/*.ts, lib/live/* | Migrare 20260930_0001: `creator_user_id uuid` cu FK/index + backfill sigur; runtime-ul scrie UUID canonic și join-urile publice folosesc `users.id = creator_user_id`. Legacy TEXT rămâne temporar doar pentru rollout/orphan audit. |
| FIXAT | Stays commission unificat pe BPS | lib/stays/config.ts, policy.ts, money.ts | `STAYS_COMMISSION_BPS` este canonic; payout/refund/clawback folosesc `applyBps`. `STAYS_COMMISSION_PCT` rămâne doar fallback temporar de migrare când BPS lipsește. |
| FIXAT | TOTP backup-code bcrypt telemetry | lib/auth/totp.ts | `bcrypt.compare` corupt este prins și logat structurat fără hash/cod sensibil; comportamentul rămâne fail-closed. |
| P3 | sendEmail fire-and-forget fără void explicit | apply-seller:49, couriers:~93 | .catch() prezent — fără unhandled rejection; doar stil. |
