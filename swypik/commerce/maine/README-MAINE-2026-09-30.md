# HANDOFF COMPLET — SWYPIK — 2026-09-30

## 0. START HERE

Workspace curent:
- `E:\Swypik\swypik-commerce-platform`
- Branch: `fix/p0-security-ci-integrated`
- Worktree-ul este FOARTE DIRTY.
- La momentul salvarii: aproximativ 95 fisiere tracked modificate + multe fisiere/migrari noi.
- Snapshot brut salvat separat:
  - `maine/GIT-STATUS-2026-09-30.txt`
  - `maine/DIFF-STAT-2026-09-30.txt`

REGULI CRITICE PENTRU RELUARE:
- NU rula `git reset --hard`
- NU rula `git clean -fd` / `git clean -fdx`
- NU face revert in masa
- NU presupune ca toate modificarile din worktree apartin unui singur task
- Inspecteaza `git diff` chirurgical inainte de orice patch
- Nu commit/push/deploy pana nu sunt validate toate schimbarile curente
- GitHub main ramane sursa de adevar pentru productie
- Ilaria AI ramane amanata in aceasta runda Swypik
- NU atinge Meister ERP VPS 178.105.46.66

---

# 1. CE S-A FACUT — SELLER / SHOPIFY / IMPORTURI

Obiectiv produs:
- feature-ul este in `swypik.com/seller`
- fiecare seller/client isi conecteaza propriul Shopify/WooCommerce
- sellerul NU gestioneaza manual tokenuri/webhooks
- modelul final: un singur app Shopify oficial Swypik, instalat de multi selleri

Implementat in cod:
- arhitectura integrari seller Shopify + WooCommerce
- credentials criptate per seller/integration
- catalog import idempotent
- CRM/customer import
- order history import
- integration worker/reconcile
- webhook infrastructure
- Shopify OAuth callback
- refresh token flow
- compliance/privacy webhooks
- Shopify uninstall/tombstone handling
- customer data request / redact
- shop redact
- seller UI/dashboard card pentru migrare/import
- integration health admin
- cron seller integration sync
- store migration UI in seller dashboard

Migrari prezente:
- `20260929_0001_seller_catalog_integrations.sql`
- `20260929_0002_seller_crm_import.sql`
- `20260929_0003_seller_order_history_import.sql`
- `20260929_0004_seller_integration_webhooks.sql`
- `20260929_0005_seller_shopify_oauth.sql`
- `20260929_0006_shopify_privacy_requests.sql`
- `20260929_0006_shopify_privacy_webhooks.sql`

Teste seller noi prezente:
- seller-catalog-connections
- seller-catalog-import-common
- seller-catalog-import-sync
- seller-customer-import-sync
- seller-imported-sales-analytics
- seller-integration-health
- seller-integration-webhook-routes
- seller-integration-webhook-setup
- seller-integration-webhook-utils
- seller-integration-worker
- seller-order-import-sync
- seller-order-provider-normalization
- seller-product-create-atomic
- seller-shopify-compliance
- seller-shopify-oauth-callback
- seller-shopify-oauth
- seller-shopify-privacy-webhooks
- seller-shopify-privacy

TODO EXTERN SHOPIFY — NU ESTE LIPSA DE COD:
- creare/publicare app oficial Shopify Swypik
- Shopify Public distribution
- preferabil Limited visibility
- setare `SHOPIFY_CLIENT_ID`
- setare `SHOPIFY_CLIENT_SECRET`
- callback:
  `https://swypik.com/api/seller/integrations/shopify/callback`
- compliance webhooks
- Shopify review
- pentru comenzi mai vechi de 60 zile: aprobare separata `read_all_orders`

UX final dorit:
1. seller intra pe `swypik.com/seller`
2. apasa Connect Shopify
3. introduce shop-ul
4. trece o singura data prin ecranul oficial Shopify Install/Authorize
5. revine automat in `swypik.com/seller`
6. Swypik importa si sincronizeaza catalog/clienti/comenzi fara configurare manuala

---

# 2. CONFIG / ENV CLEANUP

S-a introdus `intEnv` comun in:
- `lib/config/env.ts`

Au fost migrate mai multe module de la parsere locale:
- dm
- live
- social
- security abuse limits
- rides
- realtime
- ulterior si alte config-uri din worktree

Test:
- `tests/unit/config-env.test.ts`

Atentie:
- unele config-uri aveau semantic diferit clamp vs fallback. Nu inlocui mecanic fara inspectie.

---

# 3. VIDEO / FEED / ANALYTICS SECURITY

## 3.1 View dedupe persistent

Migratie:
- `db/migrations/20260929_0007_video_view_dedupe.sql`

Implementare:
- `lib/video/view-dedupe.ts`
- `app/api/videos/[id]/view/route.ts`

Acum:
- dedupe rolling 24h pe user autentificat sau identitate first-party anon
- bridge anon -> user ca login-ul sa nu dubleze view-ul
- IP/Redis ramane anti-abuz, nu sursa de adevar
- update atomic al `view_count`

Test:
- `tests/unit/video-view-dedupe.test.ts`

## 3.2 /v1/events identity spoofing

Implementare:
- `lib/events/platform-identity.ts`
- `app/api/v1/events/route.ts`
- `app/api/v1/events/batch/route.ts`
- `app/api/v1/events/compat.ts`

Acum:
- clientul nu mai poate controla autoritativ `actor_id/user_id/session_id`
- user logat -> actor din sesiunea reala
- anon -> session pseudonimizat server-side
- rate-limit IP + identitate
- batch max 50
- `session_id` este trimis corect upstream catre Go

Teste:
- `platform-event-identity.test.ts`
- `v1-events-identity.test.ts`

## 3.3 Strict Zod pentru /v1/events

Ultimul patch aplicat:
- fiecare event legacy/compat trece prin Zod
- metadata max ~16KB
- scalar fields bounded
- batch 1..50
- eveniment invalid => batch invalid, nu silent partial accept

Test:
- `tests/unit/v1-events-zod-validation.test.ts`

## 3.4 Video event target validation

Ruta:
- `app/api/videos/[id]/event/route.ts`

Acum:
- UUID validat
- `isVideoInteractable(videoId)` obligatoriu
- nu se mai insereaza watch events pentru video inexistent/private/hidden/non-safe

Test:
- `tests/unit/video-event-existence.test.ts`

## 3.5 Moderation visibility uniforma

Sursa canonica:
- `effective_label='safe'`
- DB gate din `20260926_0012_video_moderation_gate.sql`

S-a confirmat ca:
- pending_review -> effective_label pending
- rejected -> rejected
- adult/blocked raman nevizibile

S-a reparat:
- `app/api/videos/[id]/products/route.ts`
- overlay-ul de produs foloseste acum `v.effective_label='safe'`

Test:
- `video-product-overlay-moderation.test.ts`

---

# 4. FOOD

Ruta:
- `app/api/local-orders/[id]/status/route.ts`

Acum:
- 401 daca requesterul nu este nici seller nici courier
- 403 daca are un rol valid, dar incearca tranzitie rezervata celuilalt actor

Test:
- `food-order-status-auth.test.ts`
- regressie cu courier dispatch

---

# 5. NOTIFICATIONS

`DELETE /api/notifications/subscribe` era deja corect:
- delete pe `endpoint + user_id`

S-a adaugat test explicit:
- `notifications-subscribe-ownership.test.ts`

Backlog-ul a fost actualizat ca task deja rezolvat.

---

# 6. FLY

Implementat:
- rate-limit per IP
- rate-limit per first-party identity
- cache scurt pentru cautari identice
- in-process single-flight
- live price-check ramane obligatoriu inainte de plata

Fisiere:
- `lib/fly/request-identity.ts`
- `lib/fly/service.ts`
- `app/api/fly/search/route.ts`
- `app/api/fly/price-check/route.ts`

Env:
- `FLY_SEARCH_CACHE_TTL_SECONDS`

Teste:
- `fly-cost-guard.test.ts`
- `fly-search-cache.test.ts`

---

# 7. WALLET / FINANCE

## 7.1 Eliminare allowNegative generic

In `lib/wallet/ledger.ts`:
- `allowNegative: true` generic a fost eliminat
- inlocuit cu `negativeBalanceReason`

Motive permise:
- `cash_custody_debt`
- `settlement_reversal`
- `refund_clawback`

Whitelisted pe refType-uri specifice.

Actualizate:
- creator commission
- food refund
- movies
- music
- mobility
- stays

Test suite financiara rulata anterior:
- Wallet + Creator + Food + Movies + Music + Stays
- 96/96 PASS in acea etapa

## 7.2 Wallet read model

In worktree exista:
- `lib/wallet/read-model.ts`
- `app/api/account/wallet/`
- `app/[locale]/account/wallet/`
- `tests/unit/wallet-read-model.test.ts`

IMPORTANT:
- aceste modificari fac parte din worktree-ul actual si trebuie pastrate
- inspecteaza inainte de commit deoarece unele au fost facute in mesaje intermediare sarite in transcriptul curent

---

# 8. STAYS

Comision unificat pe BPS:
- `STAYS_COMMISSION_BPS` canonic
- 1000 = 10%
- payout/refund/clawback folosesc `applyBps`
- `STAYS_COMMISSION_PCT` ramane doar fallback legacy temporar

Fisiere:
- `lib/stays/config.ts`
- `lib/stays/policy.ts`
- `lib/stays/money.ts`

Teste:
- stays-policy
- stays-payment

---

# 9. DONATIONS / MONEY PARSING

Problema:
- `Math.round(amount * 100)` pe float

Fix:
- `lib/money/decimal.ts`
- parser decimal exact
- >2 zecimale => invalid, nu rotunjire
- `DonationCreateSchema` transforma direct in `amount_cents`
- ruta foloseste doar cents

Teste:
- `money-decimal.test.ts`
- `donation-amount-schema.test.ts`
- Cares flag test

Validare:
- 10/10 PASS in etapa respectiva

---

# 10. AI CHAT COST CONTROL

Ruta:
- `app/api/chat/route.ts`

Implementat:
- payload ChatPost strict/bounded
- chatHistory tipizat/bounded
- productContext tipizat/bounded
- shoppingSession schema bounded
- identity first-party:
  `lib/chat/request-identity.ts`
- rate-limit IP
- rate-limit per identity
- quota AI minute
- quota AI zilnica
- direct catalog search NU consuma quota Azure orchestration

Config in `ABUSE_LIMITS`:
- chatPerIdentity
- aiChatPerIdentity
- aiChatDailyPerIdentity

Test:
- `chat-cost-control.test.ts`

---

# 11. ADMIN FULFILLMENT CONTRACT

`app/api/admin/fulfillment/route.ts`

Acum:
- Zod discriminated union strict pe:
  - fulfill
  - add_tracking
  - cancel
- orderId trebuie UUID
- trackingNumber obligatoriu doar pe add_tracking
- tracking URL doar HTTPS
- unknown fields respinse

Test:
- `admin-fulfillment-validation.test.ts`

---

# 12. ORDER LOOKUP TOKEN

Generator extras:
- `lib/shop/order-lookup-token.ts`

Entropie:
- `crypto.randomBytes(24)`
- 24 bytes = 192 bits
- 48 hex chars

Checkout foloseste generatorul dedicat.

Test:
- `order-lookup-token.test.ts`
- verifica format, 24 bytes, sample 1000 fara duplicate

Backlog S10 marcat rezolvat.

---

# 13. PWA UPDATE LIFECYCLE

Problema:
- dupa deploy, SW putea ramane acelasi byte-for-byte si clientul putea pastra bundle vechi
- double reload observat in E2E

Fix:
- `next.config.mjs`
- `components/pwa/ServiceWorkerRegistrar.tsx`
- `public/sw.js`

Acum:
- `NEXT_PUBLIC_SW_VERSION` derivat din build id
- register `/sw.js?v=<version>`
- `updateViaCache: "none"`
- `registration.update()`
- `skipWaiting()`
- `clients.claim()`
- no-cache/no-store pentru `/sw.js`
- reload automat o singura data la `controllerchange`
- protectie sessionStorage impotriva reload loop

Test:
- `pwa-update-lifecycle.test.ts`

---

# 14. REELS CAMERA FALLBACK

Backlog-ul vechi era stale.

`components/upload/CameraCapture.tsx` deja are:
- denied/unavailable => buton Use Gallery
- onGallery revine in picker-ul aceluiasi CreateFlow

Test adaugat:
- `camera-gallery-fallback.test.ts`

---

# 15. VIDEO WATCHDOG / ORPHANS

Backlog-ul vechi era stale.

`app/api/cron/watchdog-videos/route.ts` deja:
- marcheaza failed/private/hidden uploadurile >6h
- numai daca NU au job processing
- numai daca NU exista upload session reluabila activa
- expira multipart uploads abandonate

Jurnalul E2E mentioneaza ca a curatat 13 si au ramas 0 blocate.

Test:
- `video-watchdog-orphans.test.ts`

---

# 16. PRODUCT FEED CART UX

Bug:
- ProductFeed arata `Added` optimist inainte ca serverul sa confirme
- listing necumparabil putea afisa success fals, apoi eroare

Fix:
- `ChatInterface.addToCart()` returneaza `Promise<boolean>`
- ProductFeed asteapta server confirmation
- `Added` apare doar dupa success
- `add_to_cart` analytics se trimite doar dupa success
- eroarea produce toast
- variant_required / variant_unavailable duce spre pagina produsului

Teste:
- `product-feed-cart-feedback.test.ts`

---

# 17. SEARCH RATE LIMIT

Audit:
- /api/search avea limiter
- audio/search avea limiter
- Fly avea limiter
- Geo avea limiter
- Stays avea limiter
- Users search avea limiter
- lipsea `/api/search/suggest`

Fix:
- `app/api/search/suggest/route.ts`
- bucket distribuit `suggest`

Test:
- `search-suggest-rate-limit.test.ts`
- 2/2 PASS

---

# 18. EXPLORE AUTH UX

Backlog vechi era stale.

Acum:
- video like este permis anonim
- save foloseste `useToggleAction`, rollback + redirect login pe 401
- follow foloseste `useAuthRedirect`
- alte erori => toast

Test:
- `explore-auth-actions.test.ts`

---

# 19. LIVE CREATOR UUID MIGRATION

Problema:
- `live_streams.creator_id TEXT`
- join public `u.id::text = creator_id`
- fara FK/index UUID canonic

Migratie:
- `db/migrations/20260930_0001_live_creator_uuid.sql`

Adaugat:
- `creator_user_id uuid`
- FK users(id)
- index
- backfill sigur
- runtime scrie creator_id legacy + creator_user_id
- query-urile publice folosesc UUID join
- fallback legacy doar pentru rollout/orphan audit

Actualizate:
- live streams route
- live stream [id]
- items
- pin
- live queries
- chat moderation
- lifecycle

Test:
- `live-creator-uuid-migration.test.ts`

Validare Live dupa migrare:
- 42/42 teste Live PASS
- typecheck PASS
- diff-check PASS

---

# 20. LIVE TIPS — TASK CURENT IN PROGRES

Acesta este PUNCTUL EXACT DE RELUARE.

Implementat pana acum:

Migratie:
- `db/migrations/20260930_0002_live_tips.sql`

Schema:
- live_tips
- stream_id
- sender_user_id
- creator_user_id
- amount_cents
- currency RON
- idempotency_key UUID
- UNIQUE(sender_user_id, idempotency_key)

Backend:
- `lib/live/tips.ts`
- `app/api/live/streams/[id]/tip/route.ts`

UI:
- `components/live/viewer/LiveTipButton.tsx`
- `components/live/viewer/LiveViewer.tsx`
- `components/live/viewer/LiveChat.tsx`

Realtime:
- `lib/live/chat-stream.ts`
- SSE nou: `event: tip`
- tips se publica pe acelasi Redis channel live chat
- chat normal ramane separat

Config:
- `LIVE_CONFIG.rate.tipUser`
- `LIVE_TIP_USER_LIMIT=10`
- `LIVE_TIP_USER_WINDOW=60`
- `LIVE_TIP_MIN_CENTS=100`
- `LIVE_TIP_MAX_CENTS=50000`

Traduceri:
- chei `live.tips.*` adaugate in toate 7 locale:
  en, ro, de, es, fr, it, pt

Comportament backend:
- numai user autentificat
- stream trebuie live
- self-tip interzis
- debit sender + credit creator in aceeasi tranzactie
- refType wallet: `live_tip`
- wallet currency trebuie RON
- sold insuficient => 409
- retry idempotent pe idempotency key
- realtime publish DOAR dupa commit
- duplicate retry nu publica de doua ori

Test existent:
- `tests/unit/live-tips.test.ts`
- `tests/unit/live-chat-realtime.test.ts` are test `event: tip`

ULTIMA VALIDARE INAINTEA ULTIMULUI PATCH:
- 22/22 PASS:
  - live-tips
  - live-chat-realtime
  - wallet-ledger
  - live-access
- typecheck global PASS
- i18n guard PASS:
  - 7 locale JSON valid
  - 6998 keys x 6 translations complete
  - hardcodari 0
- git diff --check PASS

IMPORTANT — ULTIMUL PATCH FACUT DUPA ACEASTA VALIDARE:
In `lib/live/tips.ts` replay/idempotency SELECT a fost mutat INAINTE de verificarea `stream.status='live'`.

Motiv:
- daca tip-ul a reusit
- reteaua cade inainte ca clientul sa primeasca raspuns
- intre timp live-ul se incheie
- retry cu aceeasi idempotency key trebuie sa intoarca tip-ul existent
- NU trebuie sa raspunda `stream_not_live`

ACEST ULTIM PATCH NU A FOST INCA RETESTAT.

PRIMII PASI MAINE:
1. Ruleaza:
   `npx vitest run tests/unit/live-tips.test.ts tests/unit/live-chat-realtime.test.ts tests/unit/wallet-ledger.test.ts tests/unit/live-access.test.ts`
2. Ruleaza:
   `npm run typecheck`
3. Ruleaza:
   `node scripts/i18n-guard.mjs`
4. Ruleaza:
   `git diff --check`
5. Adauga un test explicit:
   - tip existent
   - stream acum ended
   - aceeasi idempotency key
   - trebuie `alreadyApplied: true`
   - fara debit/credit/publish nou
6. Verifica endpoint test:
   - 401 unsigned
   - 400 invalid amount
   - 400 self_tip
   - 409 insufficient
   - 429 rate limit
   - 200 success
   - 200 replay
7. Abia dupa verde actualizeaza `docs/BACKLOG.md` task-ul:
   `Chat live + tips in live...`
   Nu marca intregul rand ca finalizat daca CDN headers + seller approval email nu sunt facute.

---

# 21. LIVE TIPS — POSIBILE EDGE CASE-URI DE VERIFICAT

- DB actual wallet schema initiala avea CHECK balance>=0; ulterior codul Wallet permite datorii tipizate.
  Verifica migrarile ulterioare pentru relaxarea constraint-ului daca vei lucra pe negative balance, dar Live tips NU folosesc negative balance.
- creator wallet row poate sa nu existe; `creditUserTx` trebuie sa o creeze ca pana acum.
- sender wallet row lipsa => ledger debit trebuie sa creeze 0 apoi InsufficientFundsError.
- live creator_user_id null pentru legacy orphan rows => tips trebuie stream_not_live/not eligible.
- idempotency conflict aceeasi key, suma/stream diferit => 409.
- retry dupa succes + stream ended => trebuie return existing.
- retry dupa succes + wallet currency schimbata ulterior => replay trebuie return existing, nu currency error.
- publish realtime failure NU trebuie sa rollback-eze bani; publish este post-commit.
- UI retry la network exception pastreaza aceeasi idempotency key.
- UI pe 4xx reseteaza pending key (corect).
- UI pe 5xx: momentan endpoint trimite 500 iar componenta trateaza ca `failed` si reseteaza key deoarece `res.status < 500` este fals, deci pending RAMANE — corect.
- page refresh dupa 500 pierde pending key client-side; pentru retry cross-refresh ar necesita persistent client operation id. Nice-to-have, nu blocant pentru prima versiune.

---

# 22. MESSENGER / DM — MODIFICARI PREZENTE IN WORKTREE

In status exista modificari/noi fisiere:
- `lib/dm/groups.ts`
- `app/api/dm/conversations/[id]/members/`
- `components/messenger/chat/GroupManageSheet.tsx`
- modificari in:
  - ChatHeader
  - ChatScreen
  - ConversationList
  - NewMessageSheet
  - dm repository/types/config
- teste:
  - `dm-groups.test.ts`
  - `dm-repository.test.ts`

Acestea au fost lucrate in mesaje intermediare sarite din transcriptul curent.
NU le sterge.
Inainte de a continua Messenger:
- inspecteaza `git diff -- lib/dm components/messenger app/api/dm`
- ruleaza testele DM dedicate
- verifica group create/add/remove ownership/admin rules
- verifica realtime/unread semantics

---

# 23. FEED / HEALTH / ADMIN — MODIFICARI PREZENTE IN WORKTREE

Exista modificari active in:
- `lib/feed/config.ts`
- `lib/feed/scoring.ts`
- `lib/feed/cards/optional.ts`
- `tests/unit/feed-rank.test.ts`
- `lib/health.ts`
- `app/(site)/admin/health/*`
- `app/api/admin/integration-health/`

Nu le reseta. Inspecteaza si valideaza cand reluam modulele respective.

---

# 24. BACKLOG ACTUAL IMPORTANT

Fisierul central:
- `docs/BACKLOG.md`

Task-uri inca active importante:
- Shopify external launch/config
- Stripe test keys in production env / real payment E2E
- Battles: zero backend, doar UI — trebuie implementat sau eliminat
- Faza 5 partial flows:
  - Food
  - Stays
  - Go
  - Live
  - Missions
  - Seller
- Live row:
  - tips aproape gata
  - CDN cache headers inca de verificat
  - email la seller approve inca de verificat
- dead code audit:
  `scripts/audit-dead-code.mjs`

Task-uri marcate fixate in backlog in aceasta runda:
- video view dedupe
- v1 events identity spoofing
- food auth status
- notifications ownership
- Fly provider cost
- P2 S7-S10
- strict Zod contracts
- feed cart UX
- PWA update
- camera fallback
- orphan videos watchdog
- public search rate limit
- Explore auth UX
- moderation visibility
- donations decimal money
- Live creator UUID
- Stays BPS
- TOTP logging

---

# 25. TESTE / VALIDARE — ISTORIC CURENT

Ultimul full suite rulat INAINTE de ultimele module noi:
- 282 suites
- 2,447 tests PASS
- 3 skipped
- 0 failed

Dupa aceea au mai fost implementate:
- Live UUID
- moderation overlay
- donations money
- AI chat cost control
- video event existence
- order lookup token
- fulfillment strict Zod
- events strict Zod
- PWA update
- camera fallback test
- watchdog orphan regression
- ProductFeed cart feedback
- search suggest limiter
- Explore auth regression
- Live tips

Targeted validations reusite dupa aceste schimbari:
- Live UUID: 42/42 PASS + typecheck
- moderation/live package: 37/37 PASS + typecheck
- donations: 10/10 PASS
- P2 S7-S10 package: 15/15 PASS + typecheck
- strict API contracts: 15/15 PASS + typecheck
- PWA/API contracts: 10/10 PASS + typecheck
- PWA/camera/watchdog/cart: 5/5 PASS + typecheck
- search suggest: 2/2 PASS
- Live tips/wallet/live realtime: 22/22 PASS + typecheck + i18n + diff-check

DAR:
- ultima modificare de replay ordering in `lib/live/tips.ts` NU a fost retestata.
- full `npm test` NU a fost rerulat dupa toate aceste schimbari recente.

Build:
- anterior `npm run build` nu putea porni deoarece slotul heavy al Bridge-ului era ocupat 1/1.
- asta NU a fost un build failure.
- trebuie reincerct dupa ce targeted + full tests sunt verzi.

---

# 26. PRIMUL CHECKLIST DE MAINE

Ordinea recomandata:

## A. Stabilizeaza Live tips
1. inspect `git diff -- lib/live/tips.ts app/api/live/streams/[id]/tip components/live/viewer db/migrations/20260930_0002_live_tips.sql`
2. adauga replay-after-ended test
3. run Live tips targeted tests
4. typecheck
5. i18n guard
6. diff-check

## B. Ruleaza full regression
`npm test`

Daca verde:
- noteaza noul count exact
- NU commit-ui inca daca mai sunt schimbari nevalidate din DM/seller/feed

## C. Reincearca build
`npm run build`

## D. Valideaza modulele din worktree care nu sunt complet documentate in transcript:
- DM/groups
- Seller/import/OAuth suite
- Wallet read model
- Health/integration health
- feed rank/config

## E. Continua backlog-ul functional
Prioritate propusa:
1. Live: termina tips + CDN headers
2. Seller approve email
3. Missions
4. Go fleet/franchise
5. Food end-to-end
6. Stays end-to-end
7. Battles — implementare sau eliminare
8. UI polish cross-app
9. dead-code audit

---

# 27. BUILD / DEPLOY — NU FACE AUTOMAT

Nu s-a facut commit/push/deploy pentru acest lot mare.

Inainte de deploy:
- targeted tests
- full npm test
- typecheck
- i18n guard
- diff-check
- build
- inspect migrations order/name conflicts
- inspect duplicate migration number:
  exista doua fisiere `20260929_0006_...`
  - shopify_privacy_requests
  - shopify_privacy_webhooks
  Verifica runner-ul de migrari daca suporta duplicate prefix numbers/names.
- verifica `db/schema.sql` vs migrations
- inspecteaza fisierul deleted:
  `docs/qa/e2e/__pycache__/qa_common.cpython-312.pyc`
  Este bytecode Python si probabil poate ramane sters, dar NU presupune fara inspectie.
- nu copia fisiere local direct pe productie
- merge/deploy prin fluxul oficial al repo-ului

---

# 28. ATENTIE LA MIGRARI

Migrari noi curente:
- 20260929_0001 seller catalog
- 20260929_0002 seller CRM
- 20260929_0003 seller order history
- 20260929_0004 seller webhooks
- 20260929_0005 Shopify OAuth
- 20260929_0006 Shopify privacy requests
- 20260929_0006 Shopify privacy webhooks
- 20260929_0007 video view dedupe
- 20260930_0001 live creator UUID
- 20260930_0002 live tips

De verificat:
- ordinea efectiva a migration runner-ului
- duplicate `0006`
- compatibilitatea cu DB prod
- daca schema_migrations foloseste filename intreg sau prefix numeric

NU redenumi migrare dupa ce a fost aplicata in vreun mediu fara sa verifici history.

---

# 29. NOTE DE PRODUS

Swypik target:
- Super App global
- Social/Creators/Reels/Live
- Commerce/Marketplace/Seller ERP
- Food
- Go/Rides/Fleet/franchise
- Stays/Travel/Fly
- Media/Movies/Music/News
- Gaming
- Messenger
- Wallet
- Search
- Notifications
- Reputation
- Admin/Risk
- Ilaria ulterior

Principii:
- nimic fake
- fara flows care doar mimeaza succes
- serverul este sursa de adevar
- financial actions atomic + idempotent
- provider-cost endpoints rate-limited
- no silent catches pe erori importante
- UI premium, rapid, conversion-focused
- seller-specific data isolation stricta

---

# 30. COMANDA RAPIDA DE RELUARE

Din PowerShell:

```powershell
cd E:\Swypik\swypik-commerce-platform
git status --short
git diff -- lib/live/tips.ts app/api/live/streams/[id]/tip components/live/viewer db/migrations/20260930_0002_live_tips.sql
npx vitest run tests/unit/live-tips.test.ts tests/unit/live-chat-realtime.test.ts tests/unit/wallet-ledger.test.ts tests/unit/live-access.test.ts
npm run typecheck
node scripts/i18n-guard.mjs
git diff --check
```

Dupa ce Live tips este verde:
```powershell
npm test
npm run build
```

---

# 31. STATUS FINAL LA MOMENTUL SALVARII

- Bridge conectat si functional.
- Worktree foarte dirty, pastrat intentionat.
- Niciun reset/clean/revert in masa executat.
- Niciun commit/push/deploy executat pentru lotul curent.
- Ultimul lucru facut: hardening idempotency replay pentru Live tips.
- Exact acel ultim patch trebuie retestat primul maine.
