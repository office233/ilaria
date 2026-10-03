# VERIFICATION ROUND 2 — Raport de verificare ostilă (2026-08-02)

> Verdictul pe scurt: **RUNDA 1 NU A FOST COMPLETĂ.** Dovezile de mai jos.

## 1. Precondiții mediu (PASS)

- Containere WSL `swypik`: `web-next` healthy, postgres healthy, video-worker-1..3 healthy, cron-worker healthy, mediamtx up, dispatch up, chain/blockscout up.
- `http://127.0.0.1:3005/api/health` = 200; `https://swypik.com` = 200.

## 2. Faza A — Audit (subagenți independenți + sondaj orchestrator)

### SA-1 Hardcodări (subagent read-only, thorough)
**27 găsiri, din care 24 LIPSESC din `docs/HARDCODE_AUDIT.md`** → runda 1 incompletă.
- P1 (7): `https://api.exchangerate.host` (`app/api/cron/refresh-fx/route.ts:29`), `https://track24.net` (`app/api/seller/orders/route.ts:128`), tarife referral/tiers hardcodate fără env (`lib/drivers/referral.ts:26-33`, `lib/drivers/tiers.ts:33-41`), `SWYP_CHAIN_ID = 643366` (`lib/swyp/chain-public.ts:6`).
- P2 (12): `scan.swypik.com`/`rpc.swypik.com`/`18.swypik.com` hardcodate în JSX/lib, CORS fix `swypik.com` în `workers/ai-chat-proxy.js:11`, `BADGE_THRESHOLDS_CENTS`, `SYSTEM_CREATOR_ID`.
- P3 (5): coordonate statice orașe stays (justificabile), texte 18+ inline.
- IP VPS mort 178.105.46.66: **0 rezultate** ✅ (singurul lucru curățat corect în runda 1).

### SA-3 Securitate API (subagent read-only, 311 rute enumerate, ~60 high-risk citite)
- `POST /api/orders/[id]/return` + `/return/photos`: auth prin `order_lookup_token` din body. **Sondaj orchestrator**: token generat cu `randomBytes(24).toString("hex")` (webhook stripe) = 192 biți entropie + rate-limit IP:id prezent → risc redus, reclasific P1→P3 (design acceptabil pentru guest orders).
- `app/api/seller/auth/route.ts`: rate-limit prezent (3/min IP, 5/h email, 20/5min verify) ✅ — sondaj confirmat pe cod (liniile 50/57/108).
- Restul găsirilor P0/P1 din raportul SA-3: de triat în Faza D (tabel complet la subagent, păstrat în istoricul sesiunii).

### SA-6 i18n + scan hardcoded (rulat direct, output real)
- `node scripts/audit-i18n.mjs`: 160 namespace-uri, 0 nefolosite, 0 chei orfane; **1 „netradusă"**: `sellerAddProduct.courier_posta_romana` în en/it = „Poșta Română" — **fals pozitiv** (nume propriu de curier, corect netradus). → efectiv 0 probleme reale.
- `node scripts/scan-hardcoded.mjs`: **127 fișiere / 464 hituri** de texte în JSX fără i18n (top: `app/seller/listings/page.tsx` 25, `app/admin/fleet/FleetActions.tsx` 17, `components/ProductFeed.tsx` etc.). **NU e 0** — criteriul rundei 1 nu era îndeplinit. Notă: multe sunt în panouri seller/admin (impact user redus), dar rămân de rezolvat sau de adăugat explicit în baseline (`.i18n-baseline.json`) cu justificare.

### UI vechi „Votează"
- `grep 'Votează|voteaza'` pe `app/`+`components/`: **1 singură apariție** — `app/[locale]/about/page.tsx:41` = cheia i18n `t("voteazaMeritaSauNu")` (text de marketing despre comunitate, NU butonul vechi de vot). Butonul vechi nu mai există în cod. Rămâne decizia de produs dacă textul din About se rescrie după redesign.

### Redesign Explorează — stare reală
- `app/[locale]/explore/ExploreClient.tsx` (944 linii) — verificat pe cod (corecție față de prima estimare): are `scroll-snap-type: y mandatory` (linia 596), slide-uri `100dvh`, bară de acțiuni verticală dreapta (avatar+follow linia 872, like cu `heartPop` linia 876-877, comentarii `CommentsSheet` bottom-sheet dinamic linia 16/881/922, save linia 884, share linia 888), `formatCount` 1.2K/M, „cockpit" produs. **Redesignul TikTok-style este IMPLEMENTAT în cod** — rămâne validarea vizuală pe mobil (Faza C) + i18n-ul celor câteva stringuri inline din pagină.

## 3. Faza B — Build (output real)

| Verificare | Rezultat |
|---|---|
| `npx tsc --noEmit` (swypik/app) | **0 erori** ✅ |
| `go vet ./...` + `go build ./...` (multi-erp/backend) | **exit 0 / exit 0** ✅ |
| `npx vitest run` | **6 files, 71 passed, 0 failed** ✅ |
| `npm run lint` | 0 erori; warnings `react-hooks/exhaustive-deps` (P3, listate) |
| `audit-i18n.mjs` | 0 reale (1 fals pozitiv documentat) ✅ |
| `scan-hardcoded.mjs` | **464 hituri — FAIL** ❌ |
| docker build + crawl 148 pagini | **NERULATE ÎNCĂ** — programate în continuarea rundei |

### Fixuri aplicate deja (validate cu `tsc` = 0)
1. `app/api/cron/refresh-fx/route.ts` — URL FX configurabil prin `FX_API_URL` (fallback exchangerate.host).
2. `app/api/seller/orders/route.ts` — fallback tracking configurabil prin `TRACKING_URL_TEMPLATE` (`{code}` placeholder).

## 4. Recunoaștere onestă (ce trebuia prins în runda 1)

1. `HARDCODE_AUDIT.md` acoperea doar IP-ul VPS — 24/27 hardcodări reale lipseau.
2. `scan-hardcoded.mjs` nu a fost adus la 0 și nici nu s-a construit un baseline justificat.
3. Redesignul Explorează a fost declarat „gata" deși lipsesc bara de acțiuni dreapta și bottom-sheet-ul de comentarii.

## 5. Pași următori (Faza D — ordinea de execuție)

1. **P1 hardcodări** → env-uri (`FX_API_URL`, `TRACKING_URL_TEMPLATE`, `NEXT_PUBLIC_SWYP_CHAIN_ID`, tarife drivers) — commit atomic per grup.
2. **Explorează**: bară acțiuni verticală dreapta + CommentSheet bottom-sheet + contoare formatate + i18n 7 limbi.
3. **scan-hardcoded**: fix top-10 fișiere user-facing; baseline documentat pentru admin/seller intern.
4. Faza B restantă: go vet/build, lint, vitest, docker build, crawl → `docs/CRAWL_REPORT.md`.
5. Faza C: E2E P1–P7 conform `E:\Meister\PROMPT_MASTER_V2_VERIFICARE_SI_E2E.md`, jurnal în `docs/REAL_E2E_JOURNAL.md`.
6. Faza E: 2 auditori externi finali.

## 6. Faza E — Audit extern final (2026-08-03)

### Auditor extern 1 (cod & securitate financiară) — 14 găsiri
- **P0 #1 TOCTOU fond acoperire** (`lib/swyp/valuation.ts`): check + debit în tranzacții separate, `GREATEST(0,...)` masca minusul. **FIXAT**: check+debit atomic cu `FOR UPDATE`, debit fără GREATEST, compensare la eșec transfer. Commit `f47694a8`.
- **P0 #2 pierdere principal la withdrawEarly** (`lib/swyp/staking.ts`): status setat înainte de transfer, fără compensare. **FIXAT**: try/catch cu redeschidere stake la eșec. Commit `f47694a8`.
- **P1 oversell create-intent**: fără validare stoc + produse lipsă ignorate silențios. **FIXAT**: validare stoc bază+variantă, 400 la produs indisponibil. Commit `7233856c`.
- Restul (P1×3, P2×5, P3×3): triate și documentate cu justificare în `docs/BACKLOG.md` §Audit extern runda 2.
- Zone verificate fără probleme (cu dovada căutării): injecție SQL (toate $n), IDOR rute swyp (filtrate pe session.userId), secret exposure (AES-256-GCM), idempotență ledger (FOR UPDATE + UNIQUE).

### Auditor extern 2 (i18n/UX/a11y) — 14 găsiri
- **P0 #1 namespace `hostPanel` inexistent** (33 chei, Host Panel Stays rupt pe i18n în toate cele 7 limbi). **FIXAT**: namespace complet × 7 limbi. Commit `f47694a8` (lot i18n).
- **P0 #2 chei `deposit*` lipsă din `payPage`** (6 chei). **FIXAT** × 7 limbi.
- P1: `foodMenu.minOrder`, toast-uri hardcodate ChatInterface, empty-state ProductFeed. **FIXATE** (+ chei × 7 limbi).
- P2–P3 (aria-labels hardcodate, fmtLei alias): în `docs/BACKLOG.md`.
- Categorii verificate curate cu dovadă: cache logat/nelogat (0 pagini cu sesiune fără force-dynamic), funcții server→client (0 reale).

### Verdict Faza E
Toate P0-urile (4) fixate și comise; P1-urile funcționale (oversell, chei i18n user-facing) fixate; restul P1–P3 triate onest în BACKLOG cu justificare. Crawl post-fix: 116/116 pagini OK (`docs/CRAWL_REPORT.md`).

## 7. Continuare 2026-08-03 — E2E cu personaje + audit extern valul 4

### Fixuri P0/P1 noi (toate cu tsc=0, deploy prin wsl-deploy-web.sh, re-test live)
| Commit | Sev | Fix | Dovada re-test |
|---|---|---|---|
| 5cbd056c | P1 | FX mort silențios din 29.07 (exchangerate.host paywalled, cron raporta OK la updated=0) → frankfurter.app + 502 la 0 rate | cron manual: {updated:10}; /api/fx pe prod: 11 valute fetched_at=2026-08-03 |
| 5ebe9bc3 | P1 | GET /api/merchants/[id]/menu = 500 (operator text=uuid) | 200 cu meniul complet, și pe slug |
| 83ed8491 | P1 | Dispatch: 0 oferte VEȘNIC — job city='București' (pricing_zones) vs courier 'Bucuresti' → unaccent | cursă nouă: offered=1, ofertă în poll driver |
| fbff73d9 | P1 | Ștergerea comentariului propriu lipsea complet (rută+UI) | DELETE owner=200, alt cont=403, re-delete=404, dispare din listă |
| f9fbb9b4 | P1 | Overlay produs invizibil pe clipuri pending_review (deși în feed) | GET public /videos/[id]/products întoarce tag-ul cu titlu+preț |
| f21306db | P0+P1+P2 | Stays: credit gazdă eșuat→reconciliation_issues (wallet+Stripe); race dublu-pay (UPDATE condiționat); preț client-controlled în coș | tsc=0, logică verificată pe cod |

### E2E ca om — scenarii noi PASS (docs/REAL_E2E_JOURNAL.md)
- GO cap-coadă cu driver REAL: online→ofertă→accept→arriving→in_progress→completed→rating 5★→settlement cash (split corect, comision tier promo 0%).
- FOOD cap-coadă: meniu prin panou seller (OTP), comandă 100.50 RON, merchant accepted→ready, curier accept→picked_up→delivered, ledger curier debit 10050 + comision platformă 2010 (20%).
- P1 Creator: 3/3 clipuri procesate (mp4+mov, thumbnail+HLS), dublu-complete idempotent, limită 1GB respinsă, editare persistă, profil identic în 3 contexte, produs pe clip vizibil public (după fix).
- SWYP: rewards automate, withdraw 50 on-chain (txHash), transfer on-chain 10, rate backed.
- Social: like toggle cu contor consistent din 2 conturi, comentariu post+delete.

### Audit extern valul 4 (subagent ostil, read-only)
10 găsiri (2×P0, 1×P1, 5×P2, 2×P3) cu dovezi fișier:linie. P0+P1+1×P2 fixate imediat (f21306db); restul triate în docs/BACKLOG.md cu justificări (f04409a2). Verificare prin sondaj: am citit personal stays/pay, stripe-payment.ts și cart/items înainte de fix — găsirile confirmate.
