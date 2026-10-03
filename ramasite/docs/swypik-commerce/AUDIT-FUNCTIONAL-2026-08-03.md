# AUDIT FUNCȚIONAL TOTAL — 2026-08-03

> Tester: agent QA. Reguli: fără modificări cod, date de test prefixate `QATEST_`, dovezi per test.

## 0. PRE-FLIGHT Swypik

| ID | Verdict | Dovadă |
|---|---|---|
| PRE-01 | **PASS** | Toate containerele healthy: web-next, postgres, redis, platform-api, cron-worker, video-worker-1..3, mediamtx, chain, chain-rpc, minio; `swypik-dispatch` = active (systemd) |
| PRE-02 | **PASS** | `/`=200, `/en/`=200, `/de/`=200 (cu -L, redirecte locale normale) |
| PRE-03 | **FAIL** ⚠️ | `/api/fx` răspunde, dar `fx_rates.fetched_at=2026-07-29` (5 zile vechi). Cauză: upstream `api.exchangerate.host` cere acum `access_key` (`{"code":101,"missing_access_key"}`). Cron `refresh-fx` raportează „OK status=200" dar `{"updated":0}` → **eșec silențios**. Fix propus: `FX_API_URL` + access_key în env (endpointul e deja configurabil din commit 2385425a) SAU alt provider (frankfurter.app e gratuit fără cheie); cronul să raporteze FAIL când updated=0. Fișier: `app/api/cron/refresh-fx/route.ts` |
| PRE-04 | parțial | Inventar roluri users — de rulat (coloana `role`: vezi secțiunea AUTH) |
| PRE-05 | **FAIL** ⚠️ | `STRIPE_SECRET_KEY=sk_placehold...` → **cheie placeholder**! Toate testele de plată reală = BLOCKED. De confirmat cu ownerul dacă plățile merg prin altă cheie (STRIPE_* alternativ) sau sunt intenționat dezactivate. |
| PRE-06 | INFO | Flags env: `FEATURE_AI_CHAT_FULL=1`, `FEATURE_PUSH_NOTIFICATIONS=true`, `FEATURE_DM=true` (restul flag-urilor în `lib/feature-flags.ts`) |
| PRE-07 | **PASS** | cron-worker: execuții recente OK (`refresh-fx OK status=200` — dar vezi PRE-03 pentru problema mascată) |

### Găsiri P0/P1 până acum
1. **P1 — FX mort silențios din 29 iulie**: prețurile multi-valută folosesc cursuri înghețate. Cronul mascheză eșecul (raportează OK la updated=0).
2. **P1 — Stripe placeholder key**: checkout-ul cu card nu poate funcționa. De clarificat intenția.

## 1. AUTH & PROFIL

| ID | Verdict | Dovadă |
|---|---|---|
| PRE-04 | INFO | Roluri users: creator=17, shopper=5, admin=2, seller=1. Nu există rol dedicat `courier`/`driver`/`merchant` la nivel de `users.role` — acele capabilități sunt probabil în tabele separate (courier_profiles etc.), de verificat la CUR/GO. |
| AUTH-01 | **PASS** | `signup_password` → `{"success":true}`, user creat `50bda325...`, role=creator implicit, `email_verified_at=null` (grace 7 zile). Coloana reală = `email_verified_at`, nu `email_verified`. |
| AUTH-03 | **PASS** | `login_password` → sesiune validă: cu tokenul extras, `GET /api/auth` = `{"authenticated":true, customer:{...}}`. Nota: cookie emis cu `Domain=swypik.com` + `Secure` (isProd) → curl pe `127.0.0.1` nu-l retrimite automat (fals-negativ de test, nu bug). |
| AUTH-04 | **PASS** | Parolă greșită → HTTP 401, mesaj generic „Email sau parolă incorectă." (fără leak dacă emailul există), fără stack trace. |
| AUTH-05 | **PASS** | Rate limit activ: după 7×401 → `429` (secvență: 401×7, apoi 429 429 429). |
| AUTH-08 | **PASS** | `logout` → `GET /api/auth` = `authenticated:false`. |
| AUTH-06 | **PASS** (code review) | OAuth redirect sigur: `getOAuthRedirectBase()` (`lib/auth/oauth/helpers.ts:160`) folosește env `OAUTH_REDIRECT_BASE`, în prod fallback la `APP_URL` (https://swypik.com) cu console.error, `localhost:3000` doar în dev. `isSafeRedirect()` (linia 170) respinge `//`, `\\`, protocol-relative și protocoale embedded. |
| AUTH-07 | **PASS** | `forgot_password` → răspuns generic „Dacă există un cont…" (fără user-enumeration), rând nou în `password_reset_tokens` (expires now()+1h). `reset_password` cu token valid → parola schimbată; token reuse → 400; login cu parola veche → 401; login cu parola nouă → 200 (token 64). Sesiunile vechi sunt revocate în tranzacție. Rate limit: 3/h per email, 5/h per IP, 10/10min la reset. |
| AUTH-09 | **PASS** | `PATCH /api/users/me` (cu `Origin: https://swypik.com`) → `display_name="QATEST Auditor"`, `bio` actualizat, confirmat în DB (`users` row). Bonus: fără Origin sau cu `Origin: https://evil.example` → `403 {"error":"csrf"}` — CSRF/Origin guard din `middleware.ts` funcționează. |
| AUTH-10 | PARTIAL | Avatar upload (`/api/users/me/avatar`): rută există, auth-gated (`getAuthSession`); upload real cu fișier nu a fost executat în această tranșă (necesită multipart + MinIO check) — de reluat dacă e prioritar. |
| AUTH-11 | **PASS** | IDOR/guard: `PATCH /api/users/me` fără cookie → 401; `GET /api/users/me` fără cookie → 401; `DELETE /api/users/me/addresses/<uuid inexistent>` cu sesiune validă → 403 (nu 200/500). Rutele `me/*` operează exclusiv pe `session.userId` — nu există parametru de user ID manipulabil. |

**Concluzie AUTH: 9/10 PASS, 1 PARTIAL (avatar upload), 0 FAIL.** AUTH-02 (OTP email) nu s-a testat separat — flow acoperit indirect de forgot_password (emailul se trimite prin același `sendEmail`).

## 2. SHOP (marketplace)

| ID | Verdict | Dovadă |
|---|---|---|
| SHOP-01 | **PASS** (cu observație) | Tabela reală = `marketplace_products` (nu `products`). 7 produse `active`, 0 cu preț ≤0/NULL, min=12900 max=249999 cents, 0 produse la 2900 (bug „29 RON" nu a regresat). `/api/products` returnează `price` corect în RON (169 = 16900 cents). Observație: catalogul live e minuscul (7 produse, 6 = zboruri Fly + 1 TV seed). |
| SHOP-02 | **PASS** (cu finding P2) | `/api/products/[id]` → titlu, preț corect (2499.99 pt 249999 cents), imagini. **Finding P2 — rating fals**: produsele Fly au `rating:4.9` din `metadata` seed, dar `product_reviews`=0 rânduri și `ratingCount:0`. Se afișează rating fără nicio recenzie reală. TV-ul (fără metadata) are corect `rating:null`. Fix: nu afișa rating din metadata când ratingCount=0. |
| SHOP-cart | INFO | `GET /api/cart` fără sesiune → 200 (coș guest pe cookie separat — comportament intenționat de verificat la SHOP-03/04). |
| SHOP-09/FX | **FAIL** (dup. PRE-03) | Conversia multi-valută folosește `fx_rates` înghețate din 29 iulie (vezi PRE-03). Bonus: `lib/fly/fx.ts` are `EUR: 4.97` hardcodat ca fallback. |
| SHOP-03 | **BLOCKED** (Stripe) | `POST /api/checkout/create-intent` cu payload valid (`{"products":[...]}`) → validare, rate-limit, fraud-block și idempotency funcționează, dar Stripe cu cheie placeholder → mesaj corect user-friendly: „Plățile cu cardul nu sunt disponibile momentan." Observație: fiecare încercare lasă un rând `failed` în `commerce_orders` (8→9 după test) — comportament de confirmat (posibil zgomot în DB). |
| SHOP-04/05 | **BLOCKED** (Stripe) | Fără cheie Stripe reală nu se poate confirma payment intent → webhook + notificare vânzător netestabile E2E. Deblocare: cheie test `sk_test_...` + `stripe listen`/trigger. |
| SHOP-06 | **PASS** | `GET /api/me/activity` cu sesiune → 200, `{"success":true,"items":[],...}` (gol, corect — userul QATEST nu are comenzi plătite). |
| SHOP-07 | **BLOCKED** | Userul QATEST nu are rând în `swyp_balances` și plata card e blocată → hibrid SWYP netestabil aici; logica SWYP se testează la secțiunea 7 (SWYP). |
| SHOP-08 | **N/A** | Nu există `/api/returns` (404, nici director în `app/api`). Feature inexistent, nu bug. |

**Concluzie SHOP: 3 PASS, 1 FAIL (FX), 3 BLOCKED (Stripe placeholder), 1 N/A.** Findings noi: rating fals 4.9 din metadata (P2), rânduri `failed` acumulate în `commerce_orders` la fiecare încercare de checkout eșuată (P3, de confirmat intenția).

## 3. FOOD

| ID | Verdict | Dovadă |
|---|---|---|
| FOOD-01 | **BLOCKED** (fără date) | Tabele reale: `local_merchants` (1 rând), `menu_items` (0!), `local_orders` (0). Pagina `/merchant` = 404 (nu există ruta). Fără meniu în DB, fluxul food nu poate fi exersat E2E. Necesita seed de merchant+meniu QATEST sau clarificare owner: e feature live sau doar schemă pregătită? |
| FOOD-02..08 | **BLOCKED** | Cascadă din FOOD-01 (0 menu_items). |
| FOOD-09 | N/A | Fără prețuri food afișabile. |

## 4. GO (ride sharing)

| ID | Verdict | Dovadă |
|---|---|---|
| GO-01 | **PASS** | `/go` → 200. `pricing_zones`=17 rânduri (București=6, Iași/Timișoara/Cluj=2, Satu Mare=5). `FEATURE_GO` absent din env dar pagina servește (flag default on sau necontrolat de env — INFO). |
| GO-02 | **PASS** | `POST /api/rides/estimate` (payload `{pickup:{address,lat,lng},dropoff:{...}}`) → estimare reală din pricing engine: 11.35 km, 27 min, `total_cents=4327` (base 600 + dist 2497 + timp 1080 + booking 150, surge 1) — calculat din zonă, NU hardcodat. Orașul derivat server-side („București"). |
| GO-10 | **PASS** (parțial) | Estimare la lat/lng 0,0 (ocean) → 422 „Swypik Go nu e disponibil încă în zona ta." — nu cade pe București hardcodat. |
| GO-03 | **PASS** | `POST /api/rides` (cash) → cursă creată `fe3dc65d...`, rând în `rides`. |
| GO-04 | **PASS** (comportament corect fără șoferi) | Dispatch a preluat cursa: `dispatch_jobs` rând `kind=ride`, oraș București, 2 waves în ~29s → `status=no_courier` → cursa `cancelled` automat (0 curieri online din 3). Log worker: `waves=1 ... no_courier=1`. **Finding P3**: `cancel_reason` rămâne NULL la anulare de dispatch (UX: pasagerul nu află de ce); log-uri repetate `tick failed: fetch failed` în istoricul dispatch-worker (de investigat când au apărut). |
| GO-05..08 | **BLOCKED** | Fără șofer QATEST online (couriers.is_available=0). Necesită cont de driver activabil pentru flux accept→start→complete→plată. |
| GO-09 | **PASS** (indirect) | Cursa fără șofer nu rămâne blocată în `pending` — dispatch-ul o expiră singur în <1 min (vezi GO-04). Env `RIDES_WATCHDOG_*` absent → defaults. |

**Concluzie GO: 6 PASS, 4 BLOCKED (lipsă driver de test). FOOD: complet BLOCKED (0 menu_items — de clarificat cu ownerul).**

## 5. CURIER

| ID | Verdict | Dovadă |
|---|---|---|
| CUR-01 | **PASS** | `/courier` → 200, `<link rel="manifest" href="manifest.webmanifest">` prezent (308→manifest.json=200). |
| CUR-02 | **PARTIAL** | `/become-a-courier` = 404 — nu există pagină publică de aplicare. Există însă API `/api/couriers/*` (connect, earnings, my-code, payouts, status) și 3 curieri `approved` în DB → onboarding-ul se face pe alt drum (admin sau flux vechi). De clarificat ruta oficială de aplicare. |
| CUR-04 | **PASS** (schemă) | Coloana reală = `is_online` (nu `is_available`). Toți 3 curierii: `is_online=f` → explică `no_courier` la GO-04. Toggle-ul e prin `/api/couriers/status`. **Finding P3 (date)**: curierul „Driver Țest" are `city='Driver Țest'` — câmp completat greșit (validare lipsă la onboarding?). |
| CUR-05 | **BLOCKED** | `push_subscriptions`=0 rânduri → push netestabil fără un device abonat. |
| CUR-06 | **BLOCKED** | `courier_location_history`=0 rânduri — niciun curier n-a fost online vreodată local; flux netestabil fără sesiune de curier. |
| CUR-03/07 | **BLOCKED** | Aprobare + earnings necesită flux complet cu comandă livrată (blocat de Stripe + lipsă comenzi food). |

**Concluzie CURIER: 2 PASS, 1 PARTIAL, 4 BLOCKED.** Findings: lipsă pagină publică de aplicare (404), date murdare în `couriers.city`.

## 6. SELLER

| ID | Verdict | Dovadă |
|---|---|---|
| SELL-01 | **PASS** (parțial) | `/seller/login` → 200 (nu 500). Auth seller = OTP pe email (`POST /api/seller/auth {action:"login"}` → „Dacă există un cont, ai primit codul pe email." — răspuns generic anti-enumeration, corect). 2 selleri în DB (unul `active` ERP-partner, unul `approved` test). Login complet netestat fără acces la inbox. |
| SELL-02..08,10..13 | **PASS** (doar randare) / **BLOCKED** (funcțional) | Toate paginile seller răspund 200: `/seller`, `orders`, `products`, `listings`, `payouts`, `returns`, `settings`, `merchant`, `cazari`. CRUD-ul efectiv necesită sesiune seller (OTP email) → BLOCKED în acest mediu. |
| SELL-09 | **PASS** (code review) | Comisioane din config env, nu hardcodate: `PLATFORM_COMMISSION_BPS` (default 1000=10%), `CREATOR_COMMISSION_BPS` 500, `MOBILITY_*`, `STAYS_COMMISSION_BPS` 1000 — toate `bpsFromEnv` în `lib/config/commerce.ts`. |
| SELL-14 | N/A | `FEATURE_STRIPE_CONNECT` absent din env; selleri au coloane stripe_* dar flag-ul nu e activ. |

**Concluzie SELLER: pagini + config OK; fluxurile CRUD BLOCKED pe OTP email (recomandare: cont seller de test cu OTP capturabil sau bypass QA în staging).**

## 7. SWYP (economie on-chain)

| ID | Verdict | Dovadă |
|---|---|---|
| SWYP-01 | **PASS** | `GET /api/swyp/wallet` (cu sesiune) → `{"balanceUnits":"0","balanceSwyp":"0.00","depositAddress":"0x8d81D0...A2971"}` — wallet custodial creat automat pentru userul QATEST; coloana reală = `swyp_balances.balance_units`. Notă: `/api/swyp/balance` nu există (404→HTML) — ruta corectă e `wallet`. |
| SWYP-02 | **PASS** (reguli) | `GET /api/swyp/earn-rules` → reguli active (go_ride +20/cursă, eats_delivery +15 etc., cu `pctOfValueBps`). Creditarea efectivă pe milestone video netestată (necesită video views reale). |
| SWYP-04 | **N/A contract diferit** | `/api/swyp/transfer` NU e P2P user→user ca în prompt, ci on-chain: `{toAddress:"0x...", amountSwyp}` către orice adresă Swypik Chain. P2P intern e tabela `swyp_p2p_transfers`. Transfer real netestat (userul QATEST are sold 0; nu inserez sold fals — `balance_units` e legat de ledger). |
| SWYP-05 | **PASS** | Chain RPC viu: `eth_blockNumber=0xbe0f` (48655) prin `http://swypik-chain-rpc:8545` (env `SWYP_CHAIN_RPC` corect). `swyp_chain_scan_cursor` = bloc 48612, actualizat azi 06:50 → scannerul de depozite rulează la zi (lag ~43 blocuri ≈ 3-4 min, normal la bloc/5s). |
| SWYP-06 | **PASS** (istoric) | `swyp_withdrawals`: 2 rânduri `sent` (900 + 100 units, 2026-08-02) — fluxul retragere a funcționat recent E2E. |
| SWYP-07 | **BLOCKED** | Env `REFERRAL_*` — de verificat; nu am creat un al doilea cont cu link referral în această tranșă. |
| SWYP-08 | **FAIL** (dup PRE-03) | FX înghețat din 29 iulie. |

**Concluzie SWYP: 4 PASS, 1 FAIL (FX), 1 N/A, 1 BLOCKED. Chain-ul e viu și sincronizat.**

## 8. SOCIAL & FEED

| ID | Verdict | Dovadă |
|---|---|---|
| SOC-01 | **PASS** | `/` → 200, feed servit; 8 videos `ready` în DB. |
| SOC-02 | **FAIL** ⚠️ P2 | Pipeline video suspect: `videos` = 15×`uploading` (blocate din 1-2 aug, >24h!), 8×`ready`, 3×`failed` (2 aug). 15 videouri stuck în `uploading` fără finalizare sau curățare — video-workerii (1..3 healthy) nu le preiau sau upload-urile au fost abandonate fără TTL cleanup. De investigat: coadă, MinIO, sau lipsă cron de expirare. |
| SOC-03 | **PASS** (infra) | `swypik-prod-mediamtx-1` Up 26h. Stream RTMP real netestat (fără sursă de test în acest mediu). |
| SOC-05 | **PASS** (randare) | `/messages` → 200. Trimitere mesaj DM real netestată (necesită 2 sesiuni simultane). |
| SOC-07 | **PASS** (schemă) | API push complet: `subscribe`, `unsubscribe`, `vapid-public-key`. `push_subscriptions`=0 → fără abonați de test. |
| SOC-08 | **PASS** | `GET /api/notifications` cu sesiune → `{"items":[],"nextCursor":null,"unreadCount":0}` — contract corect, gol legitim. |
| SOC-09 | **PASS** (schemă) | `/missions` → 200. Tabele reale = `creator_missions` + `creator_mission_submissions` (nu `missions`). Flux submit/aprobare netestat în această tranșă. |
| SOC-10 | **N/A** | `/battles` → 404 și zero rute API battle — confirmă auditul anterior: feature inexistent (decizie owner: construim sau eliminăm din nav). |
| SOC-04/06 | **BLOCKED** | Live tips necesită live activ + sold SWYP; swipe preference necesită interacțiune browser autentificată — netestate. |

**Concluzie SOCIAL: 6 PASS, 1 FAIL (videos stuck P2), 1 N/A, 2 BLOCKED.**

## 9. FLY

| ID | Verdict | Dovadă |
|---|---|---|
| FLY-01 | **PASS** | `/fly` → 200. |
| FLY-02 | **PARTIAL** | `DUFFEL_API_KEY` prezent în env; `KIWI_API_KEY` absent (kiwi.ts există dar fără cheie). Căutare live Duffel netestată (evit apeluri externe plătite din audit). |
| FLY-03 | **PASS** (code review) | Markup din env, nu hardcodat: `computeMarkupRonCents()` (`lib/fly/types.ts:130`) = max(`FLY_MARKUP_FLOOR_RON` default 1500 cenți, pct din `FLY_MARKUP`%), aplicat în `duffel.ts`/`kiwi.ts`; `booking.ts` persistă `markup_cents` separat de `provider_total_cents`. Există și `fly_route_markup` (markup per rută în DB). |
| FLY-04 | **BLOCKED** (Stripe) | Tabela reală = `flight_bookings` (nu `fly_bookings`), 0 rânduri. Rezervare test imposibilă fără cheie Stripe validă (plata biletului) — dublu blocat de PRE-05. |
| FLY-05 | **PASS** | `GET /api/trips/packages` → 200 (nu e zombie, confirmă auditul anterior). |

**Concluzie FLY: 3 PASS, 1 PARTIAL (Kiwi fără cheie), 1 BLOCKED (Stripe).**

## 10. STAYS

| ID | Verdict | Dovadă |
|---|---|---|
| STAY-01 | **PASS** (randare) / **BLOCKED** (date) | `/stays` → 200, dar `stay_properties`... nu există ca atare — tabelele reale sunt legate de `host_applications` + `stay_availability` (0 rânduri). Fără proprietăți în DB, search-ul nu are ce returna. |
| STAY-02..06 | **BLOCKED** | Cascadă: fără proprietate seed (SELL-13 blocat pe OTP seller) + Stripe placeholder → create-intent/webhook/email/calendar netestabile. `stay_bookings`=0. |

**Concluzie STAYS: pagină OK, flux complet BLOCKED (0 proprietăți + Stripe).**
