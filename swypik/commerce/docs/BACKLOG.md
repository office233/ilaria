# Backlog — Swypik

> Actualizat 2026-08-02 (Faza 2). Prioritizare: P0 = risc financiar/securitate, P1 = important, P2 = nice-to-have.

## Audit extern runda 2 (2026-08-03) — rămase conștient P1–P3

| # | Problemă | Fișier | Sev. | Justificare amânare |
|---|---|---|---|---|
| 1 | P2P transfer on-chain fără idempotencyKey (dublu-tap = dublă emisie) | `app/api/swyp/transfer/route.ts:64` | P1 | Necesită migrare DB (UNIQUE user_id+key) + schimbare client; rate-limit strict există. De făcut într-un PR dedicat cu test de concurență. |
| 2 | Cursor scan depozite fără tranzacție (FOR UPDATE în autocommit) | `lib/swyp/deposits.ts:33` | P1 | Cron-ul rulează single-instance în producție; tx_hash UNIQUE previne dublă creditare. Fix corect = advisory lock, planificat. |
| 3 | `swypTransfer` deschide tranzacție separată în interiorul tranzacției stake (pool exhaustion teoretic) | `lib/swyp/staking.ts:137` | P1 | Necesită refactor swypTransfer parametrizabil cu query-runner — schimbare invazivă pe cod financiar; volum stake-uri actual mic. |
| 4 | Datorie cash șofer nu scade referralDiscount | `lib/payments/mobility.ts:166` | P2 | Decizie de produs necesară (cine suportă discountul); contabilitatea actuală e conservatoare pentru platformă. |
| 5 | Comentarii contradictorii referral (2% vs 50%) | `lib/drivers/referral.ts:11` | P2 | Doar documentație; valorile reale sunt constantele. |
| 6 | COUNT(*) users pe fiecare mining status | `lib/swyp/mining.ts:44` | P2 | Sub 100k useri impact neglijabil; cache Redis planificat la scalare. |
| 7 | Rate-limit fallback în memorie fără Redis | `lib/security/rate-limit.ts:80` | P2 | Producția ARE Redis configurat; riscul e doar la misconfig. |
| 8 | Dust deposits marcate credited | `lib/swyp/deposits.ts:63` | P3 | Sume <0,01 SWYP; de adăugat status `dust` la următoarea migrare. |
| 9 | `BigInt(Math.round(amountSwyp*100))` pe sume din JSON | `app/api/swyp/transfer:47` | P3 | Zod limitează plaja; parse pe string planificat. |
| 10 | explorerUrl hardcodat ×4 în rute swyp | `app/api/swyp/*` | P3 | Există deja `SWYP_EXPLORER_URL` în chain-public.ts — de refolosit. |
| 11 | aria-label RO/EN hardcodate (ChatInterface, ProductFeed, MobileDashboardNav, VerifiedBadge, VideoSection, colecții) | diverse | P2-P3 | Fix mecanic în lot separat; nu blochează fluxuri. |
| 12 | `fmtLei` alias derutant în MenuClient | `MenuClient.tsx:209` | P3 | Redenumire cosmetică. |

## Securitate (din docs/SECURITY_AUDIT.md)

- [ ] **P0 S1** — `POST /api/videos/[id]/view`: dedupe views cu fingerprint/user_id (afectează ranking + plăți creator). Repro: POST repetat prin proxy-uri.
- [ ] **P0 S2** — `POST /api/v1/events{,/batch}`: legare userId de sesiune sau anonimizare explicită; rate-limit agresiv.
- [ ] **P1 S3** — `local-orders/[id]/status`: return 401 explicit când requesterul nu e nici seller nici curier.
- [ ] **P1 S4** — `notifications/subscribe` DELETE: verificare ownership pe endpoint.
- [ ] **P1 S6** — `fly/price-check`: evaluat auth/captcha (cost API Duffel/Kiwi la scraping).
- [ ] **P2 S7–S10** — chat AI cost-control, verificare existență video/produs la event-insert, audit entropie `order_lookup_token`.
- [ ] **P2** — Zod pe `admin/fulfillment` și `v1/events`; limită lungime în `ChatPostSchema`.

## Funcțional (din AUDIT-E2E-2026-08-02)

- [ ] **P0 mediu** — Chei Stripe reale de TEST în `.env.production` WSL (`sk_test_`/`pk_test_`+webhook): acum `sk_placeholder` → plăți indisponibile. După setare: rebuild web-next (pk e build-arg) + test plată 4242 4242 4242 4242 (jurnal P3).
- [ ] UX feed: buton „Coș" pe listing-uri necumpărabile — click silențios, fără toast cu eroarea API.
- [ ] PWA SW servește bundle vechi după deploy (reload dublu necesar) — skipWaiting + update prompt.
- [ ] `/reels/record` fără cameră: doar „Reîncearcă", lipsește link spre `/upload`.
- [ ] Curățare video-uri orfane „AȘTEPTARE" (probe.mp4 etc.) — watchdog-videos sau admin.
- [ ] Battles — zero cod backend, doar UI. Decizie: implementare sau eliminare UI.
- [ ] Fluxuri parțiale de finalizat (Faza 5): Food, Stays, Go, Live, Missions, Seller.
- [ ] Rate-limit Redis global pe rutele publice de search.
- [ ] Chat live + tips în live, CDN cache headers, email la seller approve (nice-to-have din prompt).

## i18n / UI

- [ ] Explore: la like/save/follow ca nelogat, API-ul dă 401 dar UI-ul face doar revert silențios — deschide modal/redirect login (UX P1).

## Curățenie (Faza 4 — din docs/DEAD_CODE.md)

- [ ] Componente/rute neimportate (rulează `scripts/audit-dead-code.mjs`).

## Audit extern Valul 4 (2026-08-03) — triaj rămase P2/P3

Fixate imediat (commit f21306db): P0 credit gazdă eșuat→reconciliation_issues (wallet+Stripe), P1 race dublu-pay stay booking, P2 preț client-controlled în coș.

| Sev | Găsire | Fișier | Justificare amânare |
|---|---|---|---|
| P2 | moderation_status nefiltrat uniform (feed/profil/recommendations arată pending_review) | app/api/explore/feed/route.ts:723, users/profile/[username]/videos:44, feed/recommendations:58 | Decizie de PRODUS: azi pipeline-ul de moderare e manual și clipurile ar dispărea din feed la publicare (UX rău). Overlay-ul de produs a fost aliniat cu feed-ul (f9fbb9b4). De rezolvat când moderarea auto e activă: filtru uniform NOT IN ('rejected') + auto-approve la N minute. |
| P2 | donations: Math.round(amount*100) pe float | app/api/donations/route.ts:73 | Impact max ±1 cent per donație; de trecut schema pe int cents la următorul refactor al rutei. |
| P2 | live_streams.creator_id e text (JOIN pe ::text, fără FK/index) | app/api/live/streams/*.ts | Necesită migrare cu date existente; performanță acceptabilă la volumul actual (<100 streams). Migrare planificată. |
| P2 | STAYS_COMMISSION_PCT vs BPS amestecate | lib/stays/booking.ts:20 | Env-ul actual nu setează PCT (fallback BPS corect =10%). De unificat pe BPS + validare la startup. |
| P3 | bcrypt.compare catch{} fără log în TOTP backup codes | lib/auth/totp.ts:113 | Doar telemetrie lipsă, comportamentul e corect (cod invalid). |
| P3 | sendEmail fire-and-forget fără void explicit | apply-seller:49, couriers:~93 | .catch() prezent — fără unhandled rejection; doar stil. |
