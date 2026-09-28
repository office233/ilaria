# SWYPIK — Specificație completă a platformei
> Document de predare · 2026-08-01 · Acoperă: ce este Swypik, fiecare funcție, fiecare rută API (303), fiecare pagină (82 user + 30 admin), economia SWYP, blockchain-ul propriu, infrastructura și modul complet de funcționare.

---

# 1. CE ESTE SWYPIK

**Swypik este un super-app de comerț prin video.** Ideea centrală: oamenii nu mai caută produse — le descoperă într-un feed vertical de clipuri scurte (ca TikTok), iar cumpărarea se face direct din clip, fără a părăsi videoclipul. Peste acest nucleu sunt construite verticale de servicii: livrare de mâncare (Food/Eats), ride-hailing (Go), bilete de avion (Fly), cazări (Stays), donații (Cares), plus o economie proprie cu monedă internă (**SWYP**) ancorată într-un **blockchain privat propriu** (Swypik Chain, chainId 643366).

**Domenii live:** swypik.com (aplicația) · scan.swypik.com (explorer blockchain) · rpc.swypik.com (RPC public chain) · cdn.swypik.com / media.swypik.com (media).

## 1.1 Actorii platformei
| Rol | Ce face | Cum intră |
|---|---|---|
| **Shopper** | cumpără din feed, comandă mâncare, curse, zboruri, cazări | register/login (email, Google, Apple) |
| **Creator** | urcă video-uri cu produse tag-uite; câștigă 5% comision din vânzările generate | aplicație → aprobare admin |
| **Seller** | vinde produse în marketplace; poate conecta ERP-ul propriu | aplicație → aprobare |
| **Merchant** | restaurant/magazin local cu meniu și comenzi la domiciliu | înregistrare → aprobare |
| **Curier** | livrează comenzi locale; primit prin dispatch automat | înrolare → verificare |
| **Șofer (Go)** | curse de persoane; program Founding Drivers cu tiers | înrolare → verificare |
| **Gazdă (Stays)** | listează cazări, gestionează calendar și rezervări | aplicație → aprobare |
| **Fleet partner** | franciză de flotă (mai mulți șoferi) | aplicație → aprobare |
| **Cauză/ONG** | campanii de donații cu raportare transparentă a cheltuielilor | înregistrare → verificare |
| **Developer** | apps terțe prin OAuth2 + webhooks (App Store intern) | înregistrare → aprobare |
| **Admin** | moderare, finanțe, risc, cron, tot | login separat cu 2FA |

## 1.2 Modelul de bani
- **Comision marketplace:** 10% din valoarea comenzii.
- **Comision creator (afiliere):** 5% din vânzările atribuite video-ului său.
- **Mobilitate (Go):** 20% platformă / 80% șofer.
- **Stays:** 10% oprit din prețul gazdei.
- **Fondul SWYP:** 10% din comisionul NET al platformei intră în fondul de acoperire care dă valoarea monedei SWYP.

---

# 2. STACK TEHNIC ȘI INFRASTRUCTURĂ

## 2.1 Componente
| Componentă | Tehnologie | Rol |
|---|---|---|
| Aplicația web + API | **Next.js 15** (App Router), React, TypeScript | frontend PWA + 303 rute API |
| API secundar | **Go 1.26** (`services/platform-api`, port 8090 intern) | rute de performanță: feed, events, creators; proxy prin `/api/v1/*` |
| Bază de date | **PostgreSQL 16** (~65 migrări) | tot ce e persistent |
| Cache + cozi | **Redis 7** (streams `video:jobs`, pub/sub dispatch/DM) + Upstash (rate-limit) | |
| Storage | **MinIO** (S3 self-hosted) + Cloudflare R2; CDN pe cdn.swypik.com | video, imagini |
| Procesare video | **video-worker** Python+FFmpeg ×3 instanțe | MP4 → HLS + thumbnail + preview |
| Live streaming | **mediamtx** — RTMP :1935 ingest → HLS :8888 | live shopping |
| Blockchain | **geth** (Clique PoA), 1 validator, bloc la 5s + **Blockscout** explorer | Swypik Chain |
| Plăți | **Stripe** (PaymentIntents, webhooks, Identity, Connect Express) | fiat |
| AI | OpenRouter/Gemini prin Cloudflare Worker (`ai-chat-proxy`) | chat asistent, clasificare, hashtags |
| Email | **Resend** (+ SMTP fallback) | tranzacțional + digest |
| Observabilitate | pino (JSON logs), Sentry, `/api/health/*`, cron heartbeat | |

## 2.2 Securitate
- **Sesiuni multi-rol** pe cookie-uri separate (shopper / seller / admin / creator) — un browser poate fi logat simultan pe roluri diferite.
- **CSRF**: verificare origin pe toate metodele mutante (middleware.ts).
- **2FA TOTP** pentru conturi (secret criptat AES-256-GCM), bcrypt pe parole.
- **Rate limiting** per-endpoint (Upstash Redis) — chei dedicate: login, register, checkout, swypWithdraw (3/5min), swypTransfer (5/5min), geo, search etc.
- **CSP + HSTS** + security headers în next.config.mjs.
- **Audit log** pe checkout (lib/security/audit-log.ts).
- **RPC chain public**: metodele periculoase (`personal_*`, `admin_*`, `debug_*`, `eth_sendTransaction`...) blocate în nginx; doar citire + `eth_sendRawTransaction` (tranzacții deja semnate).

## 2.3 Joburile automate (cron-worker, loop 60s, auth Bearer CRON_SECRET)
| Interval | Job | Ce face |
|---|---|---|
| 5 min | `publish-scheduled` | publică video-urile programate |
| 5 min | `refresh-rank` | reîmprospătează view-ul materializat `video_rank_14d` (explore) |
| 5 min | `dispatch-tick` | motorul de dispatch: expiră oferte, extinde valurile 2→5→10 km |
| 5 min | `scan-chain-deposits` | scanează Swypik Chain și creditează depozitele SWYP |
| 10 min | `watchdog-videos` | detectează video-uri blocate în procesare |
| 15 min | `embed-batch`, `classify-pending` | embeddings pgvector + clasificare AI produse |
| 30 min | `process-payouts` | transferă bani sellerilor/creatorilor (Stripe Transfers) |
| 1 h | `swyp-view-milestones` | recompense SWYP la praguri de vizualizări |
| 1 h | `refresh-fx` | cursuri valutare (afișare multi-monedă) |
| 1 h | `alert-video-queue`, `aggregate-video-stats`, `fly-price-watch` | alerte + statistici + competitivitate prețuri zbor |
| 4 h | `abandoned-cart` | emailuri coș abandonat |
| 6 h | `detect-trends` | detectare trenduri |
| zilnic | `suspend-unverified` | suspendă conturile neverificate după 7 zile |
| zilnic | `strikes-decay` | expiră strike-urile vechi |
| zilnic | `cleanup-tokens`, `alert-dispute-deadlines`, `reconcile-wallets`, `battles/close`, `indexnow`, `bing-url-submit` | curățenie, alerte dispute <72h, reconciliere ledger, SEO ping |
| zilnic | `reclaim-abandoned-swyp` | recuperează SWYP debitat în checkout-uri abandonate |
| săptămânal | `email-digest` | digest pe email |
| la cerere | `daily-maintenance` | orchestrator mentenanță |

---

# 3. FUNCȚIILE PLATFORMEI — FIECARE MODUL ÎN DETALIU

## 3.1 VIDEO COMMERCE (nucleul)

### Fluxul creatorului
1. **Upload** (`/upload`, wizard): `POST /api/creator/upload-session` creează sesiunea → fișierul urcă în MinIO → job în Redis stream `video:jobs`.
2. **Procesare**: video-worker (FFmpeg) produce HLS multi-bitrate + thumbnail + preview animat → publică pe cdn.swypik.com; `GET /api/creator/videos/[id]` (polling status).
3. **AI la upload**: `POST /api/creator/upload-suggestions` (+ `/regenerate`) — titlu/descriere/hashtags sugerate; `POST /api/ai/suggest-hashtags`.
4. **Tag-uri de produse**: `GET/PUT /api/creator/videos/[id]/product-tags` — produse legate de clip, cu timestamp pentru overlay „vezi produsul".
5. **Programare**: `scheduled_publish_at` → cron `publish-scheduled`.
6. **Bibliotecă + editare**: `GET /api/creator/videos`, `PATCH/DELETE /api/creator/videos/[id]`; transcriere `POST .../transcribe` (temporar dezactivată); subtitrări `GET/POST /api/videos/[id]/captions` + `/captions/list`.
7. **Statistici**: `GET /api/creator/analytics`, `GET /api/creator/earnings` — venituri din comision 5%.
8. **Aplicație creator**: `POST /api/creator/apply` → admin aprobă via `POST /api/admin/applications/[id]/approve|reject`.

### Fluxul consumatorului
- **Feed universal** — `GET /api/feed/universal?vertical=&city=&country=&limit=&page=` — inima aplicației: amestecă video-uri, oferte, verticale, personalizat.
- **Recomandări** — `GET /api/feed/recommendations` (fast-path Postgres; versiunea Go pe `/api/v1/feed`).
- **Explore** — `GET /api/explore/feed` (paginat pe view-ul materializat `video_rank_14d`, fără COUNT scump). Public, fără cont.
- **Oferte pe home** — `GET /api/feed/offers` (sort popular/new/discount, filtre preț).
- **Tracking** comportament — `POST /api/feed/event` (single), `POST /api/feed/events/batch`, `POST /api/videos/[id]/event`; acțiuni explicite — `POST /api/feed/action` (more_like_this / not_interested / follow_creator / unfollow).
- **Interacțiuni video**: like (`POST/GET /api/videos/[id]/like`), view cu rate-limit IP+video (`POST .../view`), save în colecții (`POST/GET/DELETE .../save`, one-tap `POST .../quicksave`), share (`POST .../share`), feedback (`POST .../feedback`), raport moderare (`POST .../report`), vot pe produsul din clip (`POST .../product-vote`), produsele clipului (`GET .../products`), ascundere din feed (`DELETE /api/videos/[id]/hidden`).
- **Comentarii**: `GET/POST /api/videos/[id]/comments`, like pe comentariu `POST /api/comments/[id]/like`.
- **Colecții**: CRUD `GET/POST /api/collections`, `GET/PATCH/DELETE /api/collections/[id]`, items `POST/GET /api/collections/[id]/items`, `DELETE .../items/[videoId]`.
- **Video individual**: pagini `/v/[id]` (shortlink), `/video/[id]`; status procesare `GET /api/videos/[id]/status`.
- **Audio**: `GET /api/audio/tracks` — track-uri licențiate pentru clipuri; pagina `/audio/[id]` (clipuri care folosesc un sunet).
- **Recorder în browser**: pagina `/reels/record` (înregistrare direct din PWA).

### Live shopping
- `POST/GET /api/live/streams` — creare/listare; mediamtx primește RTMP, hooks `POST /api/internal/live/started|ended`.
- Per stream: chat (`POST/GET .../chat`), produse prezentate (`POST/GET .../items`), pin produs (`POST .../pin`), poll (`POST/GET .../poll`), detalii/editare (`GET/PATCH /api/live/streams/[id]`). Pagini: `/live`, `/live/[id]`.

### Misiuni (bounty-uri pentru creatori)
- `GET /api/missions` — branduri/selleri pun bounty per vânzare; pagini `/missions`, `/missions/[slug]`.

### Arena (community posts)
- `GET/POST /api/posts`, `GET /api/posts/[slug]`, vot `POST /api/posts/[slug]/vote`. (Formatul „battle" a fost retras.)

## 3.2 MARKETPLACE PRODUSE

### Catalog & discovery
- `GET /api/products` (catalog storefront din `marketplace_products`), `GET /api/products/[id]`, similare (`GET /api/products/similar`), video-urile care prezintă produsul (`GET /api/products/[id]/videos`).
- Interacțiuni produs: like / save / share / reviews (`POST /api/products/[id]/like|save|share`, `GET/POST .../reviews`; review helpful `POST /api/reviews/[id]/helpful`; editare/ștergere proprie `PATCH/DELETE /api/reviews/[id]`).
- Căutare: `GET /api/search` + autocomplete `GET /api/search/suggest` (produse, categorii, #hashtags, @useri). Categorii: `GET /api/categories`.
- Pagini: `/shop`, `/product/[id]`, `/categories`, `/categories/[slug]`, `/best`, `/best/[slug]`, `/search`, `/hashtag/[tag]`, `/sellers/[id]`, `/b/[slug]` (brand shortlink).

### Coș & checkout
- Coș guest (cookie anonim) + logat, cu merge automat la login: `GET/DELETE /api/cart`, `POST /api/cart/items`, `PATCH/DELETE /api/cart/items/[id]`, `POST /api/cart/merge`.
- **Checkout securizat**: clientul trimite DOAR productId/quantity/skuId — prețurile se recalculează server-side. `POST /api/checkout` + `POST /api/checkout/create-intent` (Stripe PaymentIntent; suportă plata hibridă cu SWYP max 50%).
- Webhook: `POST /api/webhooks/stripe` — confirmă plata, scrie comanda, declanșează hooks SWYP, detectează refunds.
- Comenzi client: `GET /api/orders`, `GET /api/orders/[id]`, istoricul contului `GET /api/auth/orders`.
- **Retururi**: `POST /api/orders/[id]/return` + poze dovadă `POST .../return/photos`; sellerul acceptă/respinge (`POST /api/seller/orders/[id]/return/accept|reject`); adminul aprobă/respinge final (`POST /api/admin/returns/[orderId]/approve|reject`). *(feature flag `returns` — actualmente OFF)*
- Fraud: scoring la comenzi, `GET /api/admin/orders/risk`, decizie manuală `POST /api/admin/orders/[id]/fraud-decision`, blocare user `POST /api/admin/users/[id]/fraud-block`.

### Panoul sellerului
- Auth separat `POST /api/seller/auth`; dashboard `GET /api/seller/dashboard`.
- Produse: `GET/POST /api/seller/products`, upload imagine, clasificare AI (`POST .../classify`).
- Comenzi + refund: `GET/POST /api/seller/orders`, `POST /api/seller/orders/[id]/refund`.
- Payouts: `GET /api/seller/payouts`; Stripe Connect Express: `POST/GET /api/seller/stripe-connect`, `POST /api/stripe-connect/onboarding/start`, `GET /api/stripe-connect/status`, `POST /api/stripe-connect/login-link`. *(flag `stripeConnect` OFF — de activat pentru plăți reale către selleri)*
- **ERP Connect** (integrare cu Multi-ERP/Meister): `POST/DELETE/GET /api/seller/erp/connect`, sincronizare produse `POST /api/seller/erp/sync`, asistent AI Selena `POST /api/seller/selena` (proxy spre ERP-ul sellerului).
- **API partener** (ERP push): `GET /api/partner/ping` (verificare API key), `POST /api/partner/products` (ERP împinge produse cu X-Api-Key).

### Dropshipping (AliExpress)
- Import produse, comandă automată la furnizor după plată, fulfillment prin `POST /api/admin/fulfillment` *(flag OFF)*, cron de sincronizare tracking.

### Universal marketplace (anunțuri)
- `POST/GET /api/listings` — anunțuri imobiliare/auto/servicii; lead-uri `POST/GET /api/inquiries` („Contactează vânzătorul").
- Rezervări pe sloturi orare (frizerii, cabinete, terenuri, service): `GET/POST /api/bookings/slots`.

### App Store pentru developeri
- Public: `GET /api/apps`, `GET /api/apps/[slug]`; instalări seller `GET/DELETE /api/apps/installs`.
- OAuth2 simplificat: `GET/POST /api/apps/oauth/authorize` → `POST /api/apps/oauth/token`.
- Developeri: `POST /api/developers/register` (aprobare manuală), `GET /api/developers/me`, apps CRUD `GET/POST /api/developers/apps`, `GET/PATCH /api/developers/apps/[id]`, rotire secret `POST .../rotate-secret`, livrări webhook `GET .../deliveries`.

## 3.3 FOOD / LOCAL DELIVERY

- **Merchants**: `GET /api/merchants?city=&kind=&open=1` (listă publică), `POST/PATCH` (înregistrare/editare), ale sellerului `GET /api/merchants/mine`.
- **Meniu**: `GET/POST/PATCH/DELETE /api/merchants/[id]/menu` (categorii + articole).
- **Taxa de livrare estimată înainte de comandă**: `GET /api/merchants/[id]/delivery-quote?lat=&lng=`.
- **Comenzi**: `POST/GET /api/local-orders` (plasare + listare), detaliu/tracking `GET /api/local-orders/[id]`, status `PATCH .../status` (merchant sau curier).
- **Dispatch**: `POST/PATCH /api/local-orders/[id]/dispatch` — oferă comanda curierilor online, cel mai apropiat primul; valuri 2→5→10 km prin `dispatch-tick`; SSE live `GET /api/dispatch/[jobId]/stream`.
- **Panoul merchantului**: `GET /api/merchants/[id]/orders?status=&since=` (polling comenzi).
- **Curieri**: înrolare `POST /api/couriers`, profil `GET/PATCH`, online/offline + GPS la ~10s `POST /api/couriers/status`, câștiguri `GET /api/couriers/earnings`, payouts `GET/POST /api/couriers/payouts` (aprobat de admin la `GET/POST /api/admin/courier-payouts`), Stripe Connect `GET/POST /api/couriers/connect`, cod referral `GET /api/couriers/my-code`.
- Pagini: `/food`, `/food/[slug]`, `/food/orders`, `/food/orders/[id]`.

## 3.4 GO (RIDE-HAILING)

- **Estimare fără cursă**: `POST /api/rides/estimate` — pricing engine server-side cu zone tarifare + surge (admin le editează la `GET/POST /api/admin/pricing`).
- **Cursă**: `POST /api/rides` (creare + dispatch automat), detaliu `GET /api/rides/[id]`, listare `GET /api/rides`.
- **Șoferul acceptă/refuză**: `PATCH /api/rides/[id]/dispatch` (atribuire atomică).
- **Mașina de stări strictă** cu rol per tranziție: `PATCH /api/rides/[id]/status` — driver: accepted→arriving→in_progress→completed; rider poate anula în fazele timpurii.
- **Live tracking**: SSE `GET /api/rides/[id]/stream` (status + poziția șoferului); **partajare publică a cursei** fără date sensibile: `GET /api/go/track/[token]` + pagina `/go/track/[token]`.
- **Plată**: `GET/POST /api/rides/[id]/pay` (wallet sau Stripe; split 80/20).
- **Rating bidirecțional**: `POST /api/rides/[id]/rating`.
- **Flote**: aplicație publică `POST/GET /api/fleet-partners`, admin `PATCH /api/admin/fleet-partners/[id]` și `PATCH /api/admin/fleet/[id]`; pagina `/fleet`, `/join/fleet`, `/join/franchise`.
- **Founding Drivers**: sloturi limitate cu beneficii — `GET /api/founding-slots` (contor public pe `/join`); referral șofer→client `POST /api/referral/driver-code` (codul SWK...).
- Pagini: `/go`, `/go/[id]`, `/go/history`.

## 3.5 TRAVEL

### Fly (bilete de avion)
- Căutare agregată **Duffel + Kiwi**: `POST /api/fly/search` (public, rate-limited, prețuri finale cu tot cu comision).
- Oferte „de la X€": `GET /api/fly/deals?origin=OTP`.
- **Live price check obligatoriu înainte de plată**: `POST /api/fly/price-check`.
- Rezervare: `POST/GET /api/fly/orders` (wallet sau Stripe).
- Monitorizare competitivitate: cron `fly-price-watch` + raport admin `GET /api/admin/fly/price-watch`.
- Pagini: `/fly`, `/fly/bookings/[id]`.

### Stays (cazări)
- Căutare: `POST /api/stays/search` (public), cazările locale ale gazdelor `GET /api/stays/local?city=`, autocomplete orașe `GET /api/stays/cities?q=`.
- Preț pe interval: `GET /api/stays/quote?productId=&checkIn=&checkOut=&guests=`.
- Rezervări pe nopți: `POST/GET /api/stays/bookings`, plată din wallet `POST .../pay` (debit idempotent), anulare cu politică de refund `POST .../cancel`.
- **Gazde**: aplicație `POST/GET /api/hosts/apply` (nimic public fără review), listinguri `GET/POST /api/host/listings`, editare/publicare `PATCH/DELETE /api/host/listings/[id]`, calendar disponibilitate + prețuri sezoniere `GET/POST /api/host/listings/[id]/availability` și `GET/POST /api/stays/availability`, upload poze `POST /api/host/upload`, rezervările primite `GET /api/host/bookings`, ale sellerului `GET /api/stays/mine`.
- Admin aprobă gazde: `POST /api/admin/hosts/[id]` (approve/reject/needs_info).
- Pachete vacanță (fly+stay): `GET /api/trips/packages?origin=` *(stays dezactivat până la activarea furnizorului hotelier)*.
- Pagini: `/stays`, `/stays/[id]`, `/stays/manage`, `/account/stays`, `/join/host`.

## 3.6 SOCIAL

- **Follow**: `POST/GET /api/users/[id]/follow`.
- **Profiluri publice**: `GET /api/users/profile/[username]` + video-urile `GET .../videos`; pagina `/u/[username]`; creatori sugerați `GET /api/users/me/suggested-creators`; profil public creator `GET /api/creators/[id]`.
- **DM** *(flag `dm` OFF — cod complet)*: conversații `GET/POST /api/dm/conversations`, mesaje `GET/POST .../messages`, read `POST .../read`, **SSE real-time** `GET /api/dm/stream/[id]` (Redis pub/sub). Pagini: `/messages`, `/messages/new`, `/messages/[id]`, `/inbox`.
- **Notificări in-app**: `GET /api/notifications`, `GET/POST /api/me/notifications`, citire `POST /api/notifications/[id]/read`, toate `POST /api/notifications/mark-all-read`; preferințe `GET/PATCH /api/users/me/notification-preferences`; pagina `/notifications`.
- **Push web** *(flag OFF)*: `POST /api/push/subscribe`, `POST /api/push/unsubscribe`, `GET /api/push/vapid-public-key`, `POST/DELETE /api/notifications/subscribe`.
- **Activitate unificată**: `GET /api/me/activity` (comenzi Eats + curse Go într-o listă).
- **Referral general**: `GET/POST /api/me/referral`; redirect `/r/[id]`.

## 3.7 ECONOMIA SWYP (nucleul diferențiator — detaliat în §4)

Rutele: mining `GET/POST /api/swyp/mining` · staking `GET/POST /api/swyp/stake` · portofel+istoric `GET /api/swyp/wallet` · retragere on-chain `POST/GET /api/swyp/withdraw` · **transfer P2P on-chain** `POST/GET /api/swyp/transfer` · cât pot plăti în SWYP `GET /api/swyp/quote?totalCents=` · cursul real `GET /api/swyp/rate` · transparență publică supply `GET /api/swyp/supply` · regulile de câștig din DB `GET /api/swyp/earn-rules`.
Pagini: `/pay` (portofel + mining + staking + send/deposit/withdraw), `/swyp` (transparență publică).

## 3.8 SWYPIK CARES (donații)

- Înregistrare cauză/ONG: `GET/POST /api/causes` (verification_status='pending' → verificare).
- Campanii publice cu progres: `GET /api/campaigns`; management de către cauze verificate `GET/POST/PATCH /api/campaigns/manage`.
- **Transparența cheltuielilor**: `GET/POST /api/campaigns/manage/expenses` — cauza raportează fiecare plată.
- Donații: `POST /api/donations` (pending până la confirmarea plății).

## 3.9 CONT, AUTH, TRUST

### Autentificare
- Unificată: `POST/GET/DELETE /api/auth` (login/register/logout), sesiune curentă `GET /api/auth/me`.
- OAuth: Google (`GET /api/auth/oauth/google/start|callback`), Apple (`GET/POST /api/auth/oauth/apple/start|callback`); deconectare provider `DELETE /api/users/me/oauth/[provider]`.
- **Bearer tokens pentru PWA/mobile**: `POST /api/auth/token` (email+parolă), refresh `POST /api/auth/token/refresh`, revoke `POST /api/auth/token/revoke`.
- **2FA TOTP**: init/enable/disable/regenerate-backup sub `/api/users/me/2fa/*`.

### Profil & setări
- `GET/PATCH /api/users/me`, avatar `POST /api/users/me/avatar`, adrese `GET/POST /api/users/me/addresses` + `PATCH/DELETE .../[id]`, video-uri salvate `GET /api/users/me/saved-videos`, preferință limbă `POST /api/i18n/preferences`.
- Onboarding: interese `POST/GET /api/onboarding/interests`, skip `POST /api/onboarding/skip`, complete `POST /api/users/me/onboarding/complete`.
- Pagini cont: `/account` + subpaginile addresses, edit, security, settings, preferences, notifications, orders, returns, saved, liked, hidden, stays, age-verification.

### Verificare vârstă (conținut adult)
- **Stripe Identity**: start `POST /api/age-verification/start`, status `GET .../status`, opt-in `PATCH .../opt-in`, webhook `POST /api/webhooks/stripe-identity`.

### Trust & moderare
- Raportare video (`POST /api/videos/[id]/report`) → coadă moderare.
- Admin moderare: dismiss / hide-video / delete-video / ban-creator (7 zile) sub `/api/admin/moderation/[id]/*`.
- **Strikes cu decay**: `GET/POST /api/admin/strikes`, cron zilnic de expirare; suspendare user `POST /api/admin/users/[id]/suspend|unsuspend`; roluri `POST /api/admin/users/[id]/role`.
- **Moderare unificată pentru ERP** (Multi-ERP consumă): `GET /api/internal/moderation/pending` (selleri+merchants+curieri+cauze+developeri+video într-un singur feed), decizie `POST /api/internal/moderation/decide`.
- Email tranzacțional pentru ERP: `POST /api/internal/send-email` (refolosește Resend-ul Swypik).

## 3.10 ADMIN (30 de panouri)

Dashboard central `/admin` + panouri: `users` (suspend/rol/fraud-block) · `videos` (+ reencode) · `moderation` (+detaliu) · `applications`/`aplicatii` (creatori) · `sellers` (+detaliu) · `creators` · `marketplace` (+import CSV, +new, +detaliu) · `orders` (+detaliu, risc fraud) · `returns` · `refunds` · `disputes` (Stripe chargebacks cu upload dovezi + sugestii automate) · `payouts` · `courier-payouts` · `commissions` · `finance` (raport `GET /api/admin/finance/summary`) · `pricing` (zone + surge Go) · `fleet` · `hosts` · `strikes` · `risk` · `reviews` (hide/unhide/delete) · `health` (starea sistemului) · `cron` (declanșare manuală `POST /api/admin/cron/[jobName]/trigger`) · `creator-fund` (distribuție fond lunar creatori `GET/POST /api/admin/creator-fund`).
Login separat: `POST /api/admin/login|logout`.

## 3.11 UTILITARE PLATFORMĂ

- **Geo**: reverse geocoding `GET /api/geo/reverse` (Nominatim, cache 24h), search `GET /api/geo/search`, `GET /api/geo`.
- **FX**: `GET /api/fx` — cursuri pentru afișare multi-monedă (7 limbi × monede locale).
- **Upload generic imagini**: `POST /api/upload` (validare tip+semnătură).
- **Health**: `/api/health` (public), `/api/health/full|db|redis|r2|queue`.
- **Chat AI**: `POST /api/chat` — asistent shopping cu awareness de categorii (proxy Cloudflare Worker → OpenRouter).
- **Unsubscribe email**: `GET/POST /api/unsubscribe`.
- **SEO**: sitemap-uri, IndexNow + Bing submit (cron).
- **PWA**: manifest, service worker, install prompt, push (când e ON).
- **i18n**: 7 limbi complete (ro/en/de/es/fr/it/pt), ICU plurals, formatare dată/monedă cu locale real.

---

# 4. ECONOMIA SWYP — SPECIFICAȚIE COMPLETĂ

## 4.1 Principii de bază
1. **Supply fix: 10.000.000.000 SWYP** (10¹² subunități interne; 1 SWYP = 100 subunități; on-chain 18 zecimale). **Zero emisie** — totul pre-mintat.
2. **Orice mișcare de SWYP este un TRANSFER** între părți (pool↔user), niciodată creare/distrugere. Unica primitivă: `swypTransfer()` din `lib/swyp/ledger.ts`:
   - idempotent pe `(ref_type, ref_id, kind)` — aceeași operație aplicată de 2 ori = o singură intrare;
   - `FOR UPDATE` pe ambele părți în ordine deterministă (fără deadlocks);
   - **hash-chain SHA256** per intrare sub advisory lock global — orice modificare retroactivă a ledgerului devine detectabilă (`verifyHashChain()`);
   - soldul nu coboară sub zero (CHECK în DB + verificare în tranzacție);
   - invariant verificabil: `verifySupplyInvariant()` — Σ toate soldurile = 10¹².
3. `tradable=false` în `swyp_config` — monedă internă, netradabilă pe exchange-uri externe (faza actuală). Textele din UI nu promit creștere de valoare (conformitate).

## 4.2 Distribuția genesis (identică on-chain și în DB)
| Pool | % | SWYP | Vesting |
|---|---|---|---|
| **rewards** | 55% | 5,5 mld | — (din el se plătesc toate recompensele) |
| **ecosystem** | 15% | 1,5 mld | — |
| **company** | 15% | 1,5 mld | 48 luni liniar |
| **team** | 10% | 1 mld | 48 luni + cliff 12 luni |
| **reserve** | 5% | 0,5 mld | — |

## 4.3 Cum se câștigă SWYP
- **Mining zilnic** (model Pi Network): userul pornește manual o sesiune de 24h din `/pay`; rata de bază din `swyp_config`, **înghețată la start**; **halving** automat la praguri de utilizatori (10K / 100K / 1M / 10M); **streak** +10%/zi consecutivă, cap +100%; claim idempotent pe session_id.
- **Recompense la acțiuni** — reguli în DB (`swyp_emission_rules`, expuse public prin `/api/swyp/earn-rules`): cumpărături, prima comandă, referral, milestone-uri de vizualizări pentru creatori (cron orar) etc. Fiecare regulă are **daily cap** verificat pe ledger; regulile marcate `requires_paid_tx` cer obligatoriu o **tranzacție plătită reală** (`paidTxRef` = Stripe/comandă) — anti-sybil: nu poți farma SWYP cu conturi goale.
- Hooks automate best-effort după evenimente de business (plăți, curse, livrări) — `lib/swyp/hooks.ts`.

## 4.4 Valoarea SWYP — fondul de acoperire
- **Cursul RON/SWYP = fondul de acoperire (bani) / SWYP în circulație la utilizatori.**
- Fondul (`swyp_backing_fund`) se alimentează EXCLUSIV cu **10% din comisionul net** al platformei la fiecare tranzacție reușită (`swyp_backing_pct` în config).
- Zero tranzacții → fond 0 → curs 0 (starea de lansare, corectă și onestă: `/api/swyp/rate` răspunde `backed:false`).
- **Anti-bank-run**: la răscumpărări, fondul nu poate coborî sub 20% din valoarea de la începutul lunii.
- Staking-ul SCADE circulația → crește cursul pentru toți (mecanism deflaționist intern).

## 4.5 Cum se cheltuie SWYP
- **Plată hibridă la checkout**: SWYP acoperă **max 50%** din coș (`/api/swyp/quote` spune exact cât); subunitățile se întorc în pool-ul rewards, contravaloarea în RON iese din fond; totul idempotent (`lib/swyp/hybrid-payment.ts`).
- **Staking**: transfer spre pool-ul staking pe termene (luni); bonusul la scadență vine DOAR din surplusul lunar al fondului, pro-rata (nu se promite APY fix); retragere anticipată = principalul da, bonusul 0.
- **Refunds**: comandă anulată/failed → SWYP înapoi integral; `charge.refunded` parțial → refund proporțional; recompensele aferente comenzii se revocă (anti-abuz).

## 4.6 Swypik Chain — blockchain-ul propriu
- **geth, consens Clique (Proof of Authority)**, chainId **643366**, bloc la **5 secunde**, gas limit 30M, mod archive (istoric complet).
- **1 validator** (contul `0xA7c1...2ec2`) — semnează toate blocurile. Rețea izolată (`--nodiscover`, netrestrict). Al doilea nod = RPC public read-only.
- **Explorer**: scan.swypik.com (Blockscout, branduit Swypik complet); **RPC public**: rpc.swypik.com (landing page pe GET; POST JSON-RPC; metode periculoase blocate; „Add Swypik" adaugă rețeaua în MetaMask).
- **Portofel custodial per utilizator** (`lib/swyp/wallet.ts`): cheia privată generată server-side, criptată AES-256-GCM cu AUTH_SECRET, **exportabilă oricând** de utilizator (trecere la self-custody reală). Adresa e vizibilă în `/pay`.

## 4.7 Bridge-ul aplicație ↔ chain (complet, bidirecțional)
| Direcție | Mecanism | Garanții |
|---|---|---|
| **Withdraw** (app→chain) | `POST /api/swyp/withdraw`: debit intern idempotent ÎNAINTE de chain → trezoreria REWARDS trimite SWYP nativ către portofelul userului → refund idempotent la eșec | min 1 SWYP; rate-limit 3/5min; jurnal `swyp_withdrawals`; nu se poate refund după submit on-chain |
| **Transfer P2P** (chain) | `POST /api/swyp/transfer`: semnat cu cheia CUSTODIALĂ a userului către orice adresă; verificare sold ≥ sumă+gas înainte de emitere | min 0,01 SWYP; interzis self-transfer; hash persistat imediat; jurnal `swyp_p2p_transfers`; rate-limit 5/5min |
| **Deposit** (chain→app) | userul trimite SWYP către adresa trezoreriei (afișată în `/pay`) → cron `scan-chain-deposits` (5 min) scanează blocurile, recunoaște adresele din `swyp_chain_wallets` și creditează ledgerul intern | idempotent pe tx_hash; cursor persistent pe ultimul bloc; max 600 blocuri/rulare; doar adrese de portofel cunoscute |

**Invariant economic al bridge-ului**: supply-ul intern rămâne constant — withdraw = debit intern + trimitere on-chain; deposit = primire on-chain + credit intern. Chain-ul e oglinda publică verificabilă, ledgerul intern e sursa de adevăr pentru sold.

## 4.8 Integritate & reconciliere
- Hash-chain pe ledgerul SWYP (tamper-evident) + `verifyHashChain()` batch.
- `verifySupplyInvariant()` — Σ = 10¹².
- Cron zilnic `reconcile-wallets` pe ledgerul RON (sum ledger == balances; decontări lipsă la rides/orders) → `reconciliation_issues` + alerte.
- Cron `reclaim-abandoned-swyp` — recuperează SWYP debitat în checkout-uri abandonate.
- Backup criptat GPG al cheilor chain (scripts/secure-chain-backup.sh); watchdog de sănătate chain cu chaos test.

---

# 5. FLUXURILE END-TO-END (cum trebuie să funcționeze totul, cap-coadă)

## 5.1 Discovery → Cumpărare
1. Utilizatorul deschide feed-ul (`/` sau `/explore` — fără cont) → `GET /api/feed/universal`.
2. Vede un clip cu produs tag-uit → tap pe overlay „vezi produsul" (`GET /api/videos/[id]/products`) → drawer produs.
3. Adaugă în coș (guest OK) → la checkout se loghează (coșul se face merge automat).
4. `POST /api/checkout` recalculează prețurile server-side → opțional plată hibridă (SWYP max 50% via `/api/swyp/quote`) → Stripe PaymentIntent.
5. Webhook Stripe confirmă → comanda devine `paid` → **cascada**: comision 10% platformă reținut; 5% comision creatorului al cărui video a generat vânzarea; 10% din comisionul net → fondul SWYP; hook `awardSwyp` recompensează cumpărătorul (cu `paidTxRef`, deci anti-sybil).
6. Fulfillment: dropship automat (AliExpress) sau sellerul expediază; tracking în comandă; retur în fereastra legală (flag `returns`).
7. Cron `process-payouts` (30 min) transferă banii sellerului/creatorului prin Stripe Connect.

## 5.2 Creatorul — de la video la bani
Upload → procesare HLS → tag produse → publicare (instant/programat) → feed-ul îl distribuie (rank 14 zile + evenimente) → vânzările din clip îi generează 5% → `GET /api/creator/earnings` → payout automat prin Connect → bonus: fond creator lunar distribuit de admin (`/api/admin/creator-fund`) + milestone-uri SWYP la vizualizări.

## 5.3 Food — comandă → livrare
Client alege merchant (`/food`) → meniu → `POST /api/local-orders` (cu delivery-quote înainte) → merchantul confirmă din panoul lui (`GET /api/merchants/[id]/orders`) → `POST .../dispatch` oferă cursa curierilor online (valuri 2→5→10 km, dispatch-tick la 5 min ca plasă de siguranță) → curierul acceptă → statusuri live (`PATCH .../status`) + tracking client → livrat → decontare: curierul își vede câștigurile, cere payout, adminul aprobă.

## 5.4 Go — cursă
`POST /api/rides/estimate` (zone + surge) → `POST /api/rides` → dispatch automat la șoferi → șoferul acceptă → mașina de stări (arriving→in_progress→completed) cu SSE live + link public de partajare a cursei → plată wallet/Stripe (80/20) → rating bidirecțional.

## 5.5 Travel
Fly: căutare Duffel+Kiwi → deals → **price-check live obligatoriu** → rezervare cu wallet/Stripe → price-watch cron urmărește competitivitatea. Stays: căutare → quote pe interval → rezervare → plată wallet → politica de anulare cu refund %; gazda își administrează calendarul și prețurile sezoniere; adminul aprobă gazdele.

## 5.6 Ciclul complet SWYP
Mining zilnic + recompense la cumpărături → sold intern crește → utilizatorul poate: (a) plăti hibrid până la 50% din coș; (b) face staking (bonus din surplusul fondului); (c) retrage on-chain în portofelul propriu; (d) transfera P2P oricui; (e) depune înapoi în aplicație; (f) exporta cheia privată → self-custody totală. Fiecare pas verificabil public pe scan.swypik.com. Pe măsură ce platforma încasează comisioane, fondul crește → cursul RON/SWYP crește → răscumpărarea devine garantată de bani reali.

## 5.7 Trust & siguranță
Cont nou → email de verificare (Resend) → 7 zile grace → suspendare automată dacă nu confirmă. Comportament rău → strikes cu decay → suspendări. Video-uri raportate → coadă moderare → acțiuni admin. Comenzi suspecte → scoring fraud → review manual → block. Chargebacks → panou disputes cu deadline alerts. Ledger RON reconciliat zilnic; ledger SWYP cu hash-chain criptografic.

---

# 6. STAREA ACTUALĂ (ce e gata, ce lipsește)

## Gata și live
- Feed + video pipeline + explore + live streaming + colecții + misiuni ✅
- Marketplace: catalog, coș, checkout Stripe, comenzi, seller panel, API partener/ERP ✅
- Economia SWYP completă: mining, staking, rewards anti-sybil, plată hibridă, rate/supply/earn-rules, **bridge on-chain complet (withdraw + transfer P2P + deposit)** ✅
- Swypik Chain: validator + RPC public + explorer branduit ✅
- Go backend complet (estimate/dispatch/status/pay/rating/track partajabil) ✅
- Food: comenzi + dispatch + curieri + payouts ✅
- Stays + Fly: căutare/rezervare/plată wallet ✅
- Admin: 30 de panouri ✅
- Auth complet (email, Google, Apple, 2FA, bearer tokens PWA) ✅
- i18n 7 limbi, PWA, SEO ✅

## De activat / finalizat (blocante cunoscute)
1. **Chei email Resend** → verificarea conturilor și emailurile tranzacționale (în curs).
2. **Stripe Connect ON** → sellerii/curierii pot fi plătiți real (cod gata, flag OFF).
3. **Returns + Fulfillment ON** (cod gata, flag OFF).
4. **DM + Push ON** (cod gata, flag OFF).
5. Panouri admin lipsă: aprobare merchants, verificare curieri, aprobare donații (aprobările există doar prin API-ul de moderare unificat).
6. Furnizor hotelier extern pentru pachete fly+stay.
7. Al doilea validator chain / cold-storage pentru cheile de trezorerie (recomandare de securitate).
8. Backup MinIO (video-urile) — critic înainte de scale.

---

*Inventarele brute (generate automat din cod): `docs/api-inventory.txt` (303 rute cu metode + descrieri) și `docs/pages-inventory.txt` (82 pagini user + 30 admin). Auditul tehnic cu riscuri prioritizate: `docs/AUDIT-COMPLET-2026-08-01.md`.*
