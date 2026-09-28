# Audit de securitate — Rute API Swypik

> Faza 2 (2026-08-02). 311 rute analizate, ~172 mutative. Mecanisme centrale: `getAuthSession`, `getSellerSessionId`, `hasAdminSession`, `verifyInternal` (INTERNAL_SECRET), CRON_SECRET + `timingSafeEqual`, semnătură Stripe, `getPartnerSeller` (X-Api-Key).

## 1. Grupuri OK

Toate grupurile mari sunt protejate consistent: admin (~40, `hasAdminSession`/`isAdminToken`), seller (~20), cron (26/26 cu CRON_SECRET+timingSafeEqual), webhooks Stripe (semnătură), internal (~5, `verifyInternal`), partner (~8, X-Api-Key), users/me, rides (+rateLimit), stays, couriers, stripe-connect, creator, live, host, push, age-verification, swyp, dm (+rateLimit), donations, campaigns, reviews, fly/orders, ai, local-orders (ownership), merchants.

## 2. Găsiri (P0/P1/P2)

| ID | Rută | Sev. | Problemă | Status |
|---|---|---|---|---|
| S1 | `POST /api/videos/[id]/view` | P0 | view count anonim, doar rate-limit IP — inflatable prin rotație IP; afectează ranking + plăți creator | BACKLOG (design: views anonime intenționate; de întărit dedupe cu fingerprint/user_id) |
| S2 | `POST /api/v1/events{,/batch}` | P0 | tracking events fără auth; userId din body neverificat vs. sesiune | BACKLOG (necesită decizie design analytics anonim) |
| S3 | `POST /api/local-orders/[id]/status` | P1 | lipsă bail-out 401 dacă nici seller nici curier (ownership există în query) | BACKLOG |
| S4 | `POST/DELETE /api/notifications/subscribe` | P1 | DELETE fără verificare ownership pe endpoint push | BACKLOG |
| S5 | `POST /api/admin/import` | P1 | folosea `requireAuth(req,["admin"])` în loc de sesiunea admin dedicată | **FIXAT** — aliniat la `isAdminRequest` |
| S6 | `POST /api/fly/price-check`, `search` | P1 | publice, cost API furnizori la scraping | BACKLOG (rate-limit există; de evaluat auth pe price-check) |
| S7 | `POST /api/chat` | P2 | AI chat fără auth → cost | BACKLOG |
| S8 | `videos/[id]/event`, `feedback` | P2 | INSERT fără verificare existență video | BACKLOG |
| S9 | `products/[id]/like`, `share` | P2 | idem, existență produs | BACKLOG |
| S10 | `orders/[id]/return` | P2 | auth prin `order_lookup_token` — OK dacă entropie ≥128 bit (de verificat generarea) | BACKLOG |
| S11 | `videos/[id]/captions` | P2 | raportat inițial fără ownership | **FALS POZITIV** — verificarea owner/admin există deja în cod |

## 3. Validare input

Zod prezent pe seller, cart, dm, fly, video event/feedback/report. De adus la Zod: `admin/fulfillment` (destructurare manuală), `v1/events` (normalizare custom). `ChatPostSchema` — de verificat limită lungime mesaj.

## 4. Concluzie

Structural solid; găsirile sunt majoritar endpoint-uri semi-publice by design + 2 inconsistențe (S5, S11) fixate în această fază. Restul în `docs/BACKLOG.md` cu severități.

## 5. Runda 2 — audit ostil fluxuri financiare (2026-08-02)

Auditor independent pe checkout/wallet/refund/payout/rides. **Confirmate ca SIGURE**: preț exclusiv din DB la checkout; currency server-side; semnătură Stripe; SWYP ledger cu `FOR UPDATE` bilateral + ordine anti-deadlock; mining idempotent (`ON CONFLICT ... WHERE claimed_at IS NULL`); withdraw respinge sume ≤0; preț rides exclusiv server-side; rol driver validat din DB; DM cu `assertParticipant` peste tot; cron payout cu claim atomic + TTL.

| ID | Găsire | Sev. | Analiză | Status |
|---|---|---|---|---|
| F1 | Race cron-payout ↔ seller-refund | P2 (retrogradat din P1) | Refund permis DOAR din `return_requested`, pe care cron-ul îl EXCLUDE chiar în claim-ul atomic (re-verificare `co.status` sub row lock). Fereastră reziduală: tranziție de status exact între claim și transfer — detectată și logată (`refunded_after_seller_payout`), clawback manual. | BACKLOG (alertă ops există) |
| F2 | `stripe.refunds.create()` în afara tranzacției DB | P3 | Design intenționat (comentat în cod): banii pleacă întâi, apoi TOATE consecințele DB într-un singur BEGIN/COMMIT; `idempotencyKey` previne dublu-refund la retry. | JUSTIFICAT |
| F3 | `allowNegative` în wallet ledger — boolean permisiv | P2 | Necesar pentru comision din cash (curieri), dar orice apelant îl poate pasa greșit. | BACKLOG — restricționare prin tip discriminat/whitelist caller |
| F4 | `GET /api/orders/[id]` mod admin prin cookie | — | VERIFICAT: `isAdminRequest` validează token-ul contra `admin_sessions` din DB (SHA-256 + expirare) și Bearer cu `timingSafeEqual`. | SIGUR |
| F5–F8 | streak mining la schimbare graceHours; lost-update `completed_deliveries`; `assertParticipant` returnează bool | P3 | Impact minor, nemonetar. | BACKLOG P3 |
