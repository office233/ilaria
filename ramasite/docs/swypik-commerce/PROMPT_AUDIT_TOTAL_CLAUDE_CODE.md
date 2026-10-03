# PROMPT — AUDIT TOTAL SWYPIK: FUNCȚIONAL, FĂRĂ BUG-URI, FĂRĂ HARDCODĂRI

> Copiază tot ce urmează în Claude Code, rulat din `E:\Meister\swypik\app` (sau `/mnt/e/Meister/swypik/app` în WSL).

---

## ROLUL TĂU

Ești un auditor senior + inginer de fiabilitate. Misiunea ta: să iei aplicația Swypik **modul cu modul, cap-coadă**, să găsești și să repari TOT ce e rupt, hardcodat, netradus sau nesigur. Nu raportezi doar — **repari**. Lucrezi în bucle mici: audit → fix → verificare → commit. Nu treci la modulul următor până nu e verde cel curent.

## CONTEXTUL PROIECTULUI (citește înainte de orice)

- **Stack**: Next.js App Router (`app/[locale]/` UI + `app/api/` ~66 grupuri de rute), PostgreSQL (schema în `db/`), Redis, workers Cloudflare (`workers/`), serviciu Go (`services/platform-api`), blockchain SWYP (`chain/`), i18n cu 7 limbi (`messages/`).
- **Producția rulează LOCAL în WSL** (distro `swypik`, containere `swypik-prod-*`, site pe `http://localhost:3005`, public prin Cloudflare Tunnel `swypik.com`). **INTERZIS** orice deploy pe VPS-ul 178.105.46.66 (acela e Meister ERP, alt proiect).
- **Deploy corect**: commit pe Windows → push → în WSL `bash /opt/swypik/app/scripts/wsl-deploy-web.sh` (folosește 3 compose files; NU rula doar cu prod.yml — pierzi maparea 3005 → 502).
- **Git pe Windows**: căile cu `[locale]`/`[id]` nu merg cu `git add` din PowerShell — folosește `git -c core.literalPathspecs=true add` sau bash în WSL.
- **JSON i18n**: validează `messages/*.json` cu `python3 -c "import json;json.load(open(...))"` în WSL — CR literal în stringuri a stricat build-ul în trecut.
- Istoricul audit-urilor anterioare e în `docs/AUDIT-*.md` — citește-le ca să nu re-descoperi probleme deja rezolvate (FX live, comisioane în `lib/config/commerce.ts`, prețul fals 29 RON, rating fals 4.5 — toate FIXATE deja).

## REGULI DE LUCRU (obligatorii)

1. **Un modul pe rând.** Ordinea e mai jos. Pentru fiecare modul: citește codul, rulează testele, testează live pe `localhost:3005`, repară, comite.
2. **Fiecare fix = commit atomic** cu mesaj `fix(modul): descriere` sau `refactor(modul): ...`. Nu amesteca module în același commit.
3. **Verificare reală, nu presupusă**: după fiecare fix rulezi `npx tsc --noEmit`, testele relevante și un smoke pe ruta afectată (`curl` sau Playwright). Un fix neverificat nu există.
4. **Nu inventa feature-uri.** Dacă ceva pare neterminat by design (ex. Battles = zero cod intenționat), notează în raport și treci mai departe — NU construi.
5. **Nu șterge nimic din producție** (DB, MinIO, chain). Ai voie doar migrații aditive + fixuri de cod.
6. **Dacă un fix cere decizie de produs** (ex. schimbă un default vizibil pentru utilizatori), pune-l în secțiunea „DECIZII NECESARE" din raport și NU decide singur.
7. **Raport live**: menții `docs/AUDIT-TOTAL-<data>.md` actualizat după fiecare modul: ce ai găsit / ce ai reparat (cu hash de commit) / ce rămâne.

## CE VÂNEZI (checklist per modul)

### A. Hardcodări — vânătoare sistematică
Rulează grep-uri pe FIECARE din pattern-urile astea și triază fiecare hit:
- **URL-uri**: `https?://swypik\.com`, `localhost:[0-9]+`, IP-uri hardcodate → totul prin `lib/app-url.ts` / env.
- **Bani**: `\* ?0\.[0-9]+` (comisioane inline), `29`, `4\.5`, sume literale în cod → totul prin `lib/config/commerce.ts` sau DB. Bani DOAR în cenți (integer) — orice `parseFloat`/aritmetică float pe prețuri e bug.
- **Valute/FX**: cursuri numerice literale → totul prin `fx_rates` (FX live există deja).
- **Emailuri/telefoane**: `@swypik`, `hello@`, `suport@`, `07[0-9]{8}` → prin `lib/contact.ts` / env.
- **Texte RO/EN hardcodate în JSX/erori API**: stringuri user-facing în afara `t()`/`messages/` → extrage în i18n (toate cele 7 limbi, folosește EN ca fallback la traduceri, dar cheia TREBUIE să existe în toate). Respectă `.i18n-baseline.json` — numărul din baseline nu are voie să crească; ideal scade.
- **Secrete**: chei API, tokenuri, parole în cod sau în fișiere comise → mută în env, rotește dacă e cazul, raportează.
- **Orașe/țări/liste**: liste geografice inline duplicate (`lib/stays/cities.ts` vs `lib/fly/airports.ts`) → unifică într-o sursă.
- **ID-uri/slug-uri magice**: UUID-uri sau slug-uri literale în cod → config sau DB.

### B. Corectitudine funcțională — pe fiecare flux end-to-end
Testează CA UTILIZATOR pe `localhost:3005` (Playwright sau curl cu sesiune reală):
1. **Auth**: register → login → logout → sesiune expirată → cont suspendat (nu poate acționa) → OAuth (fără fallback localhost).
2. **Shop/Checkout**: browse → produs → add-to-cart (inclusiv race: 2 requests paralele) → checkout Stripe test → webhook → comanda în `/api/me/activity` → statusuri. Verifică: produse fără preț NU sunt cumpărabile, listing-urile (zbor/cazare) NU trec prin checkout-ul de produse.
3. **Video/Social**: upload → procesare (video-worker) → feed → like/comment/share → notificări. XSS în comentarii (payload `<img onerror>`).
4. **SWYP economy**: earn (view milestones, missions) → wallet → spend la checkout → ledger consistent (suma tranzacțiilor = balance).
5. **Go (rides)**: estimate → comandă → dispatch → statusuri → watchdog anulează cursele stale. Feature flag `FEATURE_GO` respectat.
6. **Fly/Stays/Food**: căutare → ofertă → booking/comandă → plată → confirmare email.
7. **Live**: stream start/stop (mediamtx), viewer count.
8. **Seller/Creator/Courier onboarding**: aplicare → aprobare admin → capabilități noi active.
9. **Admin**: fiecare pagină admin se încarcă, acțiunile au efect, și NIMIC din admin nu e accesibil fără rol (testează cu cont simplu → 403).
10. **Cron-uri**: fiecare rută din `app/api/cron/` are schedule real (crontab WSL / run.sh) SAU e documentată de ce nu. Rulează manual fiecare cron cu secretul corect și verifică efectul + idempotența (rulare dublă = fără dublare de efecte).

### C. Securitate
- **IDOR pe fiecare rută cu `[id]`**: cu user B încearcă resursa lui user A → trebuie 403/404. Enumeră TOATE rutele cu parametri dinamici și bifează una câte una.
- **Autorizare pe mutații**: fiecare POST/PUT/DELETE cere sesiune validă + ownership/rol. Atenție la rutele `internal/` și `webhooks/` — secretul se verifică criptografic (timing-safe), nu cu `==`.
- **Webhook-uri Stripe**: verificare semnătură + idempotență (event dublu = un singur efect). Payout-urile scriu în DB ÎNAINTE de transferul Stripe (pattern-ul există deja — verifică-l pe toate căile de bani).
- **Injecție SQL**: orice interpolare de string în query-uri → parametrizare.
- **Rate limiting** pe auth, comenzi, mesaje — există și funcționează?
- **Input validation**: fiecare rută API validează body-ul (zod sau echivalent) — payload malformat = 400, nu 500.

### D. Robustețe & calitate
- `npx tsc --noEmit` = zero erori. ESLint = zero erori (warnings triate).
- Erorile API au shape uniform (`{error}` + status corect). Niciun `500` pentru inputuri previzibile.
- Floating promises (`void somePromise`) pe operații critice (notificări, emailuri) → await + retry sau coadă.
- Componente-mamut rămase (>500 linii) → listează-le în raport (split doar dacă timpul permite, cu prioritate joasă).
- Migrații: `bash tools/check-migration-drift.sh` curat; schema din `db/schema.sql` = realitatea din Postgres.
- `.env.example` complet: fiecare `process.env.X` din cod apare documentat. Rulează un scan automat și completează diferența.
- Referințe moarte: scripturi/nume de fișiere referite în `package.json`/hooks/docs care nu mai există (ex. cunoscut: `sync:catalog` → `scripts/sync-catalog.mjs` lipsă — repară sau șterge scriptul din package.json).

### E. Teste — lasă în urmă o plasă de siguranță
- Rulează întâi ce există: `tests/unit`, `tests/e2e`, `tests/e2e-full`, `tools/test-*.mjs`. Tot ce pică → repari (codul sau testul, după caz).
- Pentru fiecare bug REAL găsit și reparat → scrii un test de regresie (unit sau e2e) care ar fi prins bug-ul.
- La final: `npx playwright test --config tests/e2e-full/playwright.config.ts` verde complet.

## ORDINEA MODULELOR

1. `lib/auth` + `app/api/auth` + middleware (fundația — orice altceva depinde de ea)
2. Bani: `app/api/checkout`, `app/api/orders`, `app/api/webhooks`, `app/api/stripe-connect`, `lib/payments`, `lib/fulfillment`, payouts, `lib/config/commerce.ts`
3. Shop: `app/api/products`, `app/api/cart`, `app/[locale]/shop|product|cart|checkout`, `lib/db/product-queries.ts`
4. SWYP economy: `app/api/swyp`, wallet, ledger, missions, `chain/` (doar citire — nu atinge contractele fără decizie)
5. Social/video: feed, posts, videos, comments, dm, notifications, push, `workers/video-worker`
6. Go/rides + dispatch + couriers
7. Fly / Stays / Food (`local-orders`, merchants)
8. Live (mediamtx) + creator tools
9. Seller/partner/admin + onboarding
10. Cron + internal + webhooks (transversal)
11. i18n global (după ce toate modulele au stringurile extrase) + SEO/metadata
12. Infra: compose files, `.env.example`, scripts operaționale, `infra/hetzner`

## DEFINIȚIA LUI „GATA" (nu te opri până nu bifezi tot)

- [ ] `npx tsc --noEmit` — zero erori
- [ ] Toate testele existente + cele noi — verzi
- [ ] Zero hituri netriate la grep-urile de hardcodări (fiecare hit rămas are comentariu de ce e OK)
- [ ] Fiecare flux din secțiunea B demonstrat funcțional live (cu dovadă în raport: request/response sau screenshot)
- [ ] Fiecare rută cu `[id]` bifată anti-IDOR în raport
- [ ] `.env.example` sincronizat cu codul
- [ ] `.i18n-baseline.json` — numărul NU a crescut (ideal a scăzut; raportează delta)
- [ ] Raportul `docs/AUDIT-TOTAL-<data>.md` complet: tabel modul × (găsit / reparat / commit / rămas) + secțiunea „DECIZII NECESARE" pentru om
- [ ] Toate commit-urile pushed pe `origin/main` și deploy verificat în WSL (site 200 pe localhost:3005 și swypik.com)

## LA FINAL

Scrie un rezumat executiv (max 1 pagină) în capul raportului: câte bug-uri găsite/reparate pe severitate, câte hardcodări eliminate, ce decizii aștepți de la mine, și care sunt primele 3 riscuri rămase în proiect.
