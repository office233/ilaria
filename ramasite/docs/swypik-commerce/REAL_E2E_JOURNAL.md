# Jurnal testare reală E2E — Swypik

> Cronologic. Format: personaj/val → pas → așteptat → observat → PASS/FAIL → fix (commit).

## 2026-08-02 — Valul 1: audit ostil (SA-1..SA-6)

| Val | Găsire | Rezultat | Fix (commit) |
|---|---|---|---|
| SA-1/5 | Praguri fraud 50/70, referral 0.5/3, chain params, rate engagement sintetic duplicate — hardcodate | FAIL → FIXED | be3ade0d (lib/risk/thresholds.ts, lib/swyp/chain-public.ts, lib/config/synthetic-engagement.ts) |
| SA-2 | Fluxuri bani (checkout/wallet/refund/payout): preț din DB, FOR UPDATE, idempotency | PASS (F1–F8 triate, niciun exploit real) | docs 3f0b9768 |
| SA-3 | live/page.tsx fără i18n (texte RO hardcodate pentru toți userii) | FAIL → FIXED | fd328ce1 (namespace livePage × 7 limbi) |
| SA-4 | 3 migrări 20260513_0008_* duplicate cu 0009–0011 | FAIL → FIXED | fd328ce1 (șterse) |
| SA-6 (multi-erp) | P0: facturi recurente + dashboard KPI fără filtru tenant | FAIL → FIXED | multi-erp 1e22172 |

## 2026-08-02 — Incident deploy

- **FAIL**: după `up -d --build web-next` doar cu `docker-compose.prod.yml`, site 502 (local 000). Root cause: maparea `3005:3000` e în `docker-compose.vps.yml`, nu în prod.yml — compose a recreat containerul fără port publicat.
- **FIX**: redeploy cu scriptul canonic `scripts/wsl-deploy-web.sh` (prod+vps+minio). Re-test: local=200, https://swypik.com/en=200. Lecție notată în memoria repo.

## 2026-08-02 — Valul 2: teste + crawl

| Pas | Așteptat | Observat | Verdict |
|---|---|---|---|
| `tsc --noEmit` | 0 erori | 0 (după npm install în /opt — node_modules desincronizat) | PASS |
| vitest unit | verzi | 71/71 | PASS |
| `go test ./...` multi-erp | verzi | 28 pachete ok, 0 FAIL | PASS |
| Playwright E2E (mobil+desktop) | verzi | 48/50 → fix search.spec (h1 locale-dependent) → 50/50 | FAIL → FIXED (8bdbb99b) |
| Crawl toate paginile statice (~120 rute) pe :3005 | 200/redirect/401 | 3×404: `/cauze`, `/developers`, `/apps` — lipseau din NON_LOCALIZED_PREFIXES în middleware | FAIL → FIXED (903b0bb9) |

## Urmează


## 2026-08-02 — P1 Creator (browser real, mobil 390×844)

| Pas | Așteptat | Observat | Verdict |
|---|---|---|---|
| Signup 4 pași (`test-creator@swypik.test`, Teodor Creator, @teo_creator_test) | cont creat | wizard complet, validare username live, cont creat + redirect login | PASS |
| Login pe http://localhost:3005 | sesiune activă | API `/api/auth` 200 dar sesiunea nu persistă — cookie `Domain=swypik.com; Secure` (build prod). NU e bug: testarea autentificată se face pe https://swypik.com | N/A (limitare mediu, documentată) |
| Login pe https://swypik.com | /account | PASS — profil complet: avatar fallback, 0/0/0 contoare, "Modurile mele", banner confirmare email, welcome modal | PASS |
| Observație UX | eroare vizibilă la login eșuat local | formularul se golește fără niciun mesaj de eroare când fetch-ul nu setează cookie | BACKLOG (afișare eroare la login failure) |
| /account/edit — chei i18n | toate textele traduse | `MISSING_MESSAGE: accountEdit.displayName/linkLabelPlaceholder/removeLink` în consolă | FAIL → FIXED (180aa17d, ×7 limbi) |
| /account/edit — buton Salvează pe mobil 390×844 | click funcțional | butonul era ACOPERIT de bottom-nav (bara fixă z-20 sub nav z-30) — click interceptat, imposibil de salvat de pe telefon | **FAIL → FIXED** (fbd2cf9a: bara ridicată la `bottom-16` + safe-area, z-40) |
| Completare bio + categorii (date reale) | persistă după reload | în curs de re-test după deploy fix | ÎN CURS |
| Salvare profil (bio + categorii) | ambele persistă | categoriile persistă; **bio se pierdea la fiecare salvare**: `GET /api/auth` nu returna `bio`, deci edit-page pornea mereu cu bio="" și PATCH-ul îl golea în DB | **FAIL → FIXED** (eab68282: bio adăugat în SELECT + payload `/api/auth`) |
| Buton Salvează după fix z-index | click OK | Playwright „element not stable" persistent din cauza bannerului email care re-randează; submit prin `form.requestSubmit()` merge → redirect `/account?updated=1` | PASS cu notă (bannerul face layout shift — BACKLOG minor) |
| Re-test bio după fix eab68282 | bio persistă după reload | „Creator de test — clipuri tech și lifestyle. Cont E2E." prezent la reload + pe profilul public | **PASS** |
| Profil public `/u/teo_creator_test` (logat, ca owner) | bio + categorii + contoare | complet: avatar TC, bio, #tech #lifestyle, 0/0/0/0, link „Profilul tau" → /creator, empty-state clipuri corect | PASS |
| Observație i18n profil public | texte traduse | „URMARITORI", „Nu exista clipuri publice" — RO fără diacritice, hardcodat (nu next-intl) | BACKLOG (lot i18n pagina /u/[username]) |
| Profil văzut de vizitator NELOGAT (curl swypik.com) | identic + buton Follow | bio + #tech #lifestyle prezente, `isOwnProfile:false`, buton „Urmareste"/Follow, OG meta corecte (og:title, og:description=bio) | PASS |

## 2026-08-02 — P1b Upload clip (browser real)

| Pas | Așteptat | Observat | Verdict |
|---|---|---|---|
| /reels/record pe desktop fără cameră | fallback spre upload | „Camera indisponibilă" + doar „Reîncearcă" — fără link spre /upload | BACKLOG UX (adaugă buton „Încarcă din galerie") |
| /upload — selectare fișier (clip generat ffmpeg 720×1280, 6s, 2.4MB) | preview + Continuă | fișier acceptat, buton Continuă activ | PASS |
| Click Continuă → upload | progres + procesare | **blocat silențios**: `/api/creator/upload-session` returna presigned URL pe `http://swypik-minio:9000` (hostname intern Docker) — browserul nu-l poate accesa; XHR eșua fără mesaj | **FAIL P0 → FIXED** (cd013c42: presign semnat pe endpoint public `S3_UPLOAD_PUBLIC_ENDPOINT=https://cdn.swypik.com`, tunel CF → MinIO; env adăugat în .env.production prin append) |
| Re-test upload după fix | clip urcat + procesat de video-worker | în curs | ÎN CURS |
| Re-test upload cap-coadă după cd013c42 | presign pe host public, upload OK, HLS, publish | presign → `cdn.swypik.com` ✅; upload PUT OK; „Procesarea s-a încheiat" în <5s; detalii (titlu+descriere `#test #tech`) → Publică → `/creator/videos` arată clipul cu badge GATA | **PASS** |
| Clip pe profilul public | apare în grid | „1 clip public", card cu link `/explore?v=<id>`, contoare 1 CLIPURI | PASS |
| Deep-link `/explore?v=<id>` | feed-ul deschide clipul respectiv | feed-ul se încarcă cu rail nou, dar clipul țintit nu e adus primul (creator negăsit în primele slide-uri) | BACKLOG (verificare parametru `v` în ExploreClient) |
| Notă Playwright | — | butoanele din /upload dau „element not stable" (preview video re-randează); click programatic funcționează — nu blocează utilizatorii reali | notă |

## 2026-08-02 — P2 Shopper + interacțiuni cross-account

| Pas | Așteptat | Observat | Verdict |
|---|---|---|---|
| Signup al 2-lea cont (`test-shopper@swypik.test`, @sonia_shopper_test) prin UI | cont creat + auto-login | wizard 4 pași OK → `/account` | PASS |
| Follow @teo_creator_test din contul shopper | contor crește, buton devine „Urmărești" | profil creator: „1 URMARITORI", „Urmaresti" | PASS |
| Deep-link `/explore?v=<id>` după fix dae0ee00 | clipul creatorului primul | API pin OK; primul slide = clipul țintă cu rail-ul nou | PASS |
| Like de la shopper | contor 0→1, persistă | `aria-pressed=true`, count=1; confirmat prin API (`viewer.liked=true`) | PASS |
| Comentariu de la shopper (bottom-sheet) | apare cu autor | „1 total", card „Sonia Shopper", contor rail 0→1 | PASS |
| Verificare din contul creator | contoare identice | API: likes=1, comments=1; `/creator/videos`: clip Live | PASS |
| Curățenie | — | 2 înregistrări orfane „AȘTEPTARE" (probe.mp4 din probă API + upload eșuat pre-fix) — de curățat via watchdog-videos | notă |
| Notă infra | — | Service worker PWA servește bundle vechi după deploy (feed-ul ignora `v=` până la reload dublu) | BACKLOG (SW skipWaiting/versionare) |

## 2026-08-02 — P3 Shop: coș + checkout (shopper)

| Pas | Așteptat | Observat | Verdict |
|---|---|---|---|
| Adăugare „Zbor spre Barcelona" în coș din feed | în coș sau mesaj clar | API refuză corect (`listing_type=listing` → „Folosește formularul de contact") dar UI-ul NU arată nimic — click fără feedback | BACKLOG UX (toast cu mesajul de eroare la Coș din feed) |
| Adăugare produs real (Smart TV 55", 2499,99 RON, `listing_type=product`) | în coș | `/api/cart/items` 200, `/cart` afișează produsul, subtotal corect, livrare gratuită | PASS |
| `/checkout` | formular Stripe | **pagină complet goală** + `IntegrationError: Please call Stripe() with your publishable key. You used an empty string` — `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` nu era transmis ca build-arg, deci bundle-ul client avea "" | **FAIL P0 → FIXED** (c96ef8b5 + cdd424b4: ARG/ENV în build stage; cheia era deja în .env.production) |
| Re-test checkout după rebuild | Stripe Elements se încarcă | în curs | ÎN CURS |
| Re-test checkout după rebuild cu build-arg | pagina se randează | PASS: „Swypik Checkout" complet — produs, cantitate +/−, sumar, total 2.499,99 RON, iframe-uri Stripe încărcate (3) | PASS |
| Payment intent | client_secret | 401 de la Stripe: `STRIPE_SECRET_KEY=sk_placeholder` în .env.production — NU există chei reale de test în mediu. UI-ul tratează grațios („Plățile cu cardul nu sunt disponibile momentan"). | **LIMITARE MEDIU** — documentat în BACKLOG: setați chei Stripe test (sk_test_/pk_test_) și re-testați plata cu 4242 4242 4242 4242 |

## 2026-08-02 — P4 Fly (shopper, mobil)

| Pas | Așteptat | Observat | Verdict |
|---|---|---|---|
| `/fly` — pagină + destinații populare cu prețuri live | se încarcă | grid destinații (Viena, Barcelona…), form căutare complet | PASS |
| Click destinație Viena → căutare | rezultate reale | 20 zboruri Duffel/Lufthansa OTP→VIE, filtre (directe/ieftine/rapide), prețuri finale RON | PASS |
| Selectare zbor 373,51 RON | formular pasageri | „Pasageri & plată" cu câmpuri complete; validare corectă (butoanele Wallet/Card dezactivate până la completare) | PASS |
| Completare date pasager + Card | rezervare/plată | POST `/api/fly/orders` → 500: aceeași cheie `sk_placeholder`; UI arată clar „Rezervarea a eșuat" | LIMITARE MEDIU (aceeași cheie Stripe; fluxul e corect până la plată) |

## 2026-08-02 — P5 Food + P6 Go (shopper, mobil)

| Pas | Așteptat | Observat | Verdict |
|---|---|---|---|
| `/food` | listă restaurante | „Restaurantul Țest QA" afișat, badge ÎNCHIS, 45–60 min, livrare gratuită — comanda nu se poate testa (restaurantul e închis; corect ca logică de program) | PASS parțial (comanda blocată de program — de testat cu restaurant deschis) |
| `/go` — adrese cu autocomplete | sugestii geocoding | sugestii reale (Nominatim) pentru Piața Unirii + Otopeni | PASS |
| Estimare cursă | prețuri pe categorii | Economy 72 / Comfort 98 / Van 125 RON, ~49 min • 20.3 km | PASS |
| Comandă Economy | cursă creată + dispatch | ride `f93070a8` creat, ecran „Căutăm un șofer în zonă… (2 km)" cu timer, SOS 112, Distribuie cursa | PASS |
| Anulare gratuită | cursă anulată | „Cursă anulată — Anulare gratuită" + chestionar motiv | PASS |
| Notă UX | — | după anulare, dialogul „De ce anulezi?" rămâne cu „Anulează cursa" disabled — ordinea e ciudată (anularea s-a făcut deja) | BACKLOG minor |

## 2026-08-02 — P7 Seller + Admin

| Pas | Așteptat | Observat | Verdict |
|---|---|---|---|
| `/seller/login` OTP email (seller@swypik.test, approved) | cod 6 cifre + sesiune | OTP generat, autentificare OK → Dashboard Vânzător complet (KPI, Selena AI) | PASS |
| ⚠️ Securitate | OTP-ul NU trebuie logat | `[SELLER OTP] dev mode code` apare în log — VERIFICAT în cod: gated pe `!isProd \|\| email.endsWith("@swypik.test")` — se loghează DOAR pentru conturi de test. | JUSTIFICAT (design pentru E2E; de monitorizat să nu se extindă) |
| Pagini seller (orders/products/listings/returns/settings/merchant) | 200 | toate 200 | PASS |
| `/seller/payouts` | 200 | **500** — `column "stripe_payouts_enabled" does not exist`: pagina citește coloane Stripe Connect de pe `sellers`, dar migrarea 20260730_0013 le-a adăugat doar pe `couriers` | **FAIL P1 → FIXED** (08799656: migrare aditivă 20260802_0001, aplicată; pagina afișează corect „Cont Stripe Connect lipsă") |
| `/admin` login cu parolă + 12 pagini (health/users/applications/refunds/commissions/creators/pricing/strikes/fleet/risk/hosts/reviews) | toate 200 | login 200, toate paginile 200 cu sesiune | PASS |

## 2026-08-02 — SMOKE FINAL pe https://swypik.com

20 rute cheie (home, explore, profil, auth, cart, checkout, fly, food, go, pay, search, cauze/developers/apps, live, seller, admin, health): **toate 200** (checkout 307 = redirect login, corect). Feed pin: clipul E2E primul, likes=1, comments=1 — datele de test persistă.

## BILANȚ SESIUNE (2026-08-02)

**Bug-uri REALE găsite testând ca om și FIXATE (9):**
1. P0 — upload clip imposibil (presign pe hostname intern MinIO) — cd013c42
2. P0 — checkout complet gol (cheia publică Stripe lipsea din bundle) — c96ef8b5+cdd424b4
3. P1 — bio șters la fiecare salvare de profil — eab68282
4. P1 — buton „Salvează" profil neapăsabil pe mobil (sub bottom-nav) — fbd2cf9a
5. P1 — /seller/payouts 500 (coloane Stripe Connect lipsă pe sellers) — 08799656
6. P1 — /cauze, /developers, /apps dădeau 404 (middleware) — 903b0bb9
7. P1 — deep-link ?v= nu deschidea clipul țintit — dae0ee00
8. P2 — 3 chei i18n lipsă accountEdit — 180aa17d
9. P2 — search.spec E2E picat pe locale — 8bdbb99b

**Redesign Explorează TikTok-style**: livrat (67d315ec) + validat vizual mobil + live.
**Rămase în BACKLOG** (docs/BACKLOG.md): chei Stripe test (blocant plăți), UX toast coș, SW update, prompt login la 401, i18n /u/[username], food cu restaurant deschis.
## 2026-08-02 — Redesign Explorează TikTok-style

| Pas | Așteptat | Observat | Verdict |
|---|---|---|---|
| Crawl re-test după fix middleware | /cauze /developers /apps = 200 | 200/200/200, crawl complet 0 FAIL | PASS |
| Redesign: action rail dreapta (avatar+follow, like, comentarii, save, share cu contoare), snap-scroll, CommentsSheet bottom-sheet | UI TikTok-style pe mobil 390×844 | Rail vizibil cu toate 5 acțiunile, contoare 0 (date reale), cockpit produs păstrat cu Alternative+Cart; UI vechi „Merită/Nu merită"+coin-burst ELIMINAT din cod (commit 67d315ec) | PASS |
| Verificare vizuală screenshot mobil | fără suprapuneri, gradient ok | OK (screenshot în sesiune) | PASS |
| Like ca vizitator nelogat | 401 + invitație login | 401 primit, dar UI face doar revert silențios — fără prompt de login | **FAIL parțial → BACKLOG** (UX: deschide modal login la 401) |
| Redesign live pe swypik.com | action-bar în HTML | prezent, /en/explore = 200 | PASS |

## 2026-08-03 � Fix P1: FX mort silen?ios (din audit func?ional)

| Pas | A?teptat | Observat | Verdict |
|---|---|---|---|
| Cauz�: api.exchangerate.host cere access_key (paywall) � 200 cu 0 rate, cron raporta OK | � | confirmat: `{"code":101,"missing_access_key"}`, fx_rates �nghe?ate 2026-07-29 | FAIL |
| Fix: provider default frankfurter.app + FX_API_ACCESS_KEY op?ional + 502 la updated=0 | cron actualizeaz� ratele | commit `5cbd056c`, deploy wsl-deploy-web.sh, cron manual � `{"updated":10}` | **FIXED** |
| Re-test prod | /api/fx cu rate proaspete | toate 11 valute fetched_at=2026-08-03, RON�EUR=0.1906 (5.2467) | PASS |

## 2026-08-03 — GO E2E cu driver real (P4+P6) + 2 fixuri P1

| Pas | Asteptat | Observat | Verdict |
|---|---|---|---|
| Bug dispatch: job city='București' (pricing_zones) vs courier city='Bucuresti' | oferte emise | 0 oferte, orice cursa murea in no_courier (confirmat pe 3 curse) | FAIL → **FIXED** commit 83ed8491 (unaccent in dispatch+surge) |
| Bug meniu public: GET /api/merchants/[id]/menu | 200 | 500 'operator text=uuid' (id uuid OR slug text pe acelasi \) | FAIL → **FIXED** commit 5ebe9bc3 |
| Driver: signup driver@swypik.test + legat de curier approved Bucuresti + online cu lat/lng | online | {success:true, online:true} | PASS |
| Cursa rider@swypik.test Unirii→Victoriei (cash) | oferta la driver | offered=1, oferta vizibila in poll couriers/status | PASS (dupa fix) |
| Accept → arriving → in_progress → completed | tranzitii + tarif final | toate 200, final_fare=2054 (=estimat, distance_source=estimate) | PASS |
| Rating rider→driver (stars:5) | medie actualizata | {ok:true}, couriers.rating=5.00 | PASS |
| Settlement cash | split corect | 'ride settled' split courier=2054, platform=0 (tier promo 0%), cash → fara ledger (corect) | PASS |
| Nota: oferta expira in ~15s (OFFER_TTL) — prima incercare 'Offer expired' | — | de evaluat UX TTL | INFO |
| Food: meniu QATEST creat prin API seller (3 categorii, 5 preparate) | meniu public vizibil | 200 dupa fix, meniul complet | PASS |

## 2026-08-03 — FOOD E2E complet (P4+P5+P6) — deblocat dupa fixuri

| Pas | Asteptat | Observat | Verdict |
|---|---|---|---|
| Meniu creat prin API seller (OTP login, 3 categorii + 5 preparate cu preturi) | 200 + public | toate create, meniu public 200 (dupa fix 5ebe9bc3) | PASS |
| Restaurant deschis (is_open_override) + vizibil in /api/merchants | listat | listat cu adresa+telefon | PASS |
| Comanda rider: 1 ciorba + 2 sarmale, cash | total corect | LO-07F65B0A, total_cents=10050 (24.50+2×38=100.50 RON) ✓ | PASS |
| Merchant: accepted → preparing → ready (cu sesiune seller) | tranzitii ok | toate 200, timestamps | PASS |
| Dispatch: oferta la curier online Bucuresti | oferta emisa | offer kind=delivery vizibil in poll (fix unaccent 83ed8491 activ) | PASS |
| Curier: accept → picked_up → delivering → delivered | tranzitii ok | toate 200, comanda delivered | PASS |
| Bani: ledger dupa livrare cash | debit curier + comision | curier debit 10050 (cash colectat), platforma credit 2010 (20% comision) | PASS |

## 2026-08-03 — P1 Creator complet + SWYP + social

| Pas | Asteptat | Observat | Verdict |
|---|---|---|---|
| Creator nou creator2@swypik.test: PATCH profil (nume+bio+website), PATCH partial bio | persista, nu sterge restul | display_name+bio persistate in DB, PATCH partial NU sterge celelalte campuri (regresia bio din 08-02 nu a revenit) | PASS |
| Upload 3 clipuri (mp4 12s, mov 10s, mp4 8s) prin upload-session (presign→PUT MinIO→PATCH complete) | 3/3 procesate | toate: job=succeeded, asset=available, thumbnail generat; HLS pe cdn.swypik.com | PASS |
| Cazuri limita: dublu-complete (idempotent), sizeBytes 2GB | fara dublare / respins | complete idempotent (acelasi videoId), 2GB → 'sizeBytes exceeds 1GB' | PASS |
| Nota API: complete e PATCH (GET ?action=complete NU declanseaza job — UI foloseste corect PATCH) | — | comportament corect, doar scriptul de test gresise | INFO |
| Publicare + aparitie in feed + editare titlu dupa publicare | in feed, editabil | in explore/feed (9 clipuri), titlu editat persistat | PASS |
| Atasare produs la clip (product-tags overlay) | vizibil public | **FAIL**: PUT ok dar GET public gol — filtrul cerea moderation_status=approved desi feed-ul NU filtreaza (clip vizibil fara buton produs) → **FIXED** f9fbb9b4 (exclude doar rejected/is_hidden) | FAIL→FIXED |
| Profil creator din 3 contexte (creator/alt user/anonim) | identic | /u/qacreator2: 4 referinte clip + nume identic in toate 3 (diferenta doar meniul propriu) | PASS |
| SWYP: rewards automate (livrare la timp => 200 SWYP la curier-rider), rate backed | balante reale | wallet 220 SWYP, rate 0.0098 RON/SWYP backed=true | PASS |
| SWYP withdraw 50 → chain + transfer on-chain 10 | tx hash | ambele cu txHash pe scan.swypik.com, balanta app 220→170 | PASS |
| Comentarii: DELETE lipsea complet (nici ruta, nici buton) | owner poate sterge | **FIXED** fbff73d9: DELETE soft owner-only + contoare + buton UI + i18n ×7 | FAIL→FIXED |

## 2026-08-03 — Fix 5 bug-uri (profil feed context, rute produse, Setari, clipuri esuate, post-upload)

| Bug | Cauza (fisier) | Fix | Verificare live |
|---|---|---|---|
| 1. Profil→clip sare in explore | ExploreClient ignora creator_id (API-ul il suporta deja) | context creator_id propagat in refetch+paginare, fara fallback la feed general | feed?creator_id=... → doar clipurile userului (1 creator distinct); feed general neschimbat (9 clipuri) — commit 5daea8f8 |
| 2. Card produs → /product generic | href hardcodat | lib/products/product-route.ts: resolver central (cta_url → verticala → fallback /product/id), folosit in ProductDrawer+ExploreClient | produs Fly are metadata vertical=fly + cta_url=/fly?dest=CDG → ruta corecta — 5daea8f8 |
| 3. Setari: Limba&moneda 404 (locale dublat '18 swypik'), Admin vizibil tuturor | LocaleSwitcher href relativ + lipsa gating | href absolut cu locale corect; intrari Admin/Devino seller gated pe rol (server-side ramane pe /admin + API 404 fara sesiune) | /ro+/en/account/preferences=200; /api/admin/users fara sesiune=404 — 41ecd372 |
| 4. Clipuri esuate pe profil (abel_varga ×2) | grila nu filtra pe status | filtrare status=ready pe profil+feed; watchdog pas 5: uploading>6h fara job → failed+private | profil public abel_varga: {videos:[]}; watchdog rulat: abandonedUploadsFailed=13 → 0 blocate ramase — 41ecd372 |
| 5. Post-upload → Creator Rewards | redirect gresit in UploadClient | publish → /v/<id> (clipul propriu), draft → /creator/drafts; intrare Creator Rewards in Setari ×7 limbi | cod confirmat + pagini 200 — 41ecd372 |

Smoke prod: /explore, /u/abel_varga, /ro/account/preferences, /fly = 200.
Nota BUG 4: cele 2 clipuri abel_varga erau deja failed+private in DB (nu a mai fost nevoie de UPDATE manual); cele 13 blocate global (conturi de test) au fost marcate failed de watchdog.

### Validare vizuala browser (prod swypik.com, mobil 390x844)
- Grila /u/qacreator2: href = /explore?v=<id>&creator_id=<uid> ✅
- Player cu context: feed?creator_id → 1 clip (doar al creatorului), un singur handle in player ✅
- Feed general fara context: 9 clipuri, neschimbat ✅
- Deep-link ?v= fara context: clip tintit + feed general (compatibilitate share-uri vechi) ✅

## 2026-08-03 — Testare manuala Setari (cont de test real, prod HTTPS)

Cont: e2e_761181@test.swypik.local (sters din DB dupa test, DELETE 2 cu FK cascade).

| Actiune | Rezultat |
|---|---|
| Signup + sesiune (cookie Secure, doar HTTPS) | PASS |
| Editeaza profil (update_profile -> displayName persista) | PASS |
| Comenzile mele (/api/auth/orders, lista corecta) | PASS |
| Adrese CRUD (create id nou, PATCH label, DELETE, lista goala) | PASS |
| Schimbare parola (set_password + relogin cu parola noua) | PASS |
| Notificari (PATCH email_marketing/push_likes -> persista la GET) | PASS |
| Deconectare (logout -> me=null) | PASS |
| Gating admin user normal (/api/admin/users=404, /admin fara UI admin, mesaj Acces) | PASS |
| CSRF activ (mutatii fara Origin corect -> {error:csrf}) | PASS |

Toate cele 9 intrari din Setari functionale end-to-end. 0 bug-uri noi gasite la aceasta runda.

## 2026-08-03 - Clarificare Descopera produsele + Missions (BUG 5.3)

- **Missions** = sistem de gamificare functional: pagini /missions + /missions/[slug] (200 live), backend complet (app/api/admin/missions/submissions, creator_mission_submissions in DB). Cardul din pagina de cont (AccountPageClient.tsx:312, href=/missions) e intentionat - recomandare: PASTRARE ca atare.
- **Descopera produsele** = card CTA spre explore (texte in messages/ro.json: descoperaProdusePrinClipuri, incepeSaDescoperi) - functional, duce corect in feed. PASTRARE.
- Ambele sunt functionale, nu schelete; nu necesita mutare in navigatie. /ro/creator = 200 (Creator Rewards accesibil si din Setari dupa fix).

### BUG 5.3 — Clarificare 'Descopera produsele' + 'Missions' (raport, fara modificari)
- **Missions** (/[locale]/missions + /api/missions + /api/admin/missions): pagina FUNCTIONALA (200, i18n complet) de 'creator missions' — branduri posteaza briefuri cu premii SWYP/RON (tabele creator_missions + creator_mission_submissions). In DB: **0 misiuni** → pagina afiseaza corect empty-state. VERDICT: functionala dar nefolosita; recomand PASTRARE + link din Creator Rewards cand exista primele misiuni reale (nu adaug navigatie pentru o lista goala).
- **'Descopera produsele'**: NU e o pagina — e empty-state-ul din contul nou ('Exploreaza feed-ul sau magazinul...') + CTA-uri de onboarding din pagina Creator. Dupa fixul redirectului post-upload (→ /v/<id>), fluxul nu mai trece pe acolo accidental. VERDICT: nimic de mutat/reparat.

## 2026-08-04 - BUG-01 REZOLVAT: /u/[username] inexistent -> 404 (era 200)
Cauza reala: loading.tsx in app/[locale]/u/[username]/ crea un Suspense boundary; streaming-ul pornea inainte de notFound(), deci statusul ramanea 200. Fixuri cumulative: ec266315 (isHTTPAccessFallbackError rethrow), 0c82fd13 (sters not-found.tsx local), 83947749 (sters loading.tsx - fixul decisiv).
Verificare live: /u/inexistent=404, /u/UPPERCASE=404, /en/u/inexistent=404, profil real=200, /explore=200.

## 2026-08-05 - Fix imagine moarta restaurant (regresie e2e /food)

- Suita Playwright e2e-full a prins console error 404 pe /food (desktop+mobile): restaurantul "Snack Grill" (local_merchants 1e1bd296) avea image_url Unsplash mort (photo-1612392062798 -> 404).
- Fix: UPDATE local_merchants SET image_url la o poza Unsplash valida (photo-1552566626, testata 200). Scan complet catalog: 0 alte imagini moarte.
- Re-test: /food + /explore PASS (desktop+mobile); suita completa 92 passed, 52 skipped, 0 fail.
- Fix aplicat doar in DB (date, nu cod) - nu necesita commit/deploy.
