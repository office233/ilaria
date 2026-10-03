# Swypik — tot ce avem de lucrat

> Generat din scanare reală a codului (`node tools/gapscan.mjs`), nu din estimări.
> **Repo:** github.com/office233/swypik-commerce-platform · **Local:** `E:\Meister\swypik\app`

---

## Cheia problemei

Avem **32 de verticale** declarate, dar doar **2 au pagină de flux** (Shop și Food).
Restul de 30 duc la `/v/[id]` — un feed generic care arată „Încă nimic aici".

Vestea bună: verticalele se grupează în **5 moduri de tranzacție**. Nu trebuie 30 de pagini —
trebuie **5 șabloane**, iar fiecare acoperă între 1 și 9 verticale.

| Mod | Verticale | Are pagină? | Ce lipsește |
|---|---|---|---|
| `cart` | 7 (Shop, Medical, Industrial, Agro, Build, Home, Farm) | 1/7 | șablon reutilizabil |
| `order` | 6 (Food, Market, Pharma, Flowers, Drinks, Send) | 1/6 | generalizarea paginii Food |
| `booking` | 9 (Stays, Trips, Events, Fly, Salon, Health, Fit, Service, Rentals) | 0/9 | tot |
| `lead` | 8 (Estates, Auto, Pro, Learn, Care, Biz, Move, Jobs) | 0/8 | tot |
| `donation` | 1 (Cares) | 0/1 | tot |
| `ride` | 1 (Go) | 0/1 | tot (fază târzie) |

---

# 🔴 BLOCANTE — fără astea nu există utilizatori

### B1. Credențiale email — **10 minute**
Codul e gata (transport dual Resend/SMTP + health check). Lipsesc doar cheile.
- Varianta rapidă: SMTP IONOS (`smtp.ionos.de:587`) cu o căsuță `noreply@swypik.com`
- Alternativ: cont Resend (3.000 mailuri/lună gratuit)
- Se pun în `.env.production` pe VPS, restart container
- **Impact:** fără el nimeni nu se poate înregistra, nu se resetează parole, nu pleacă confirmări de comandă

### B2. Produse în catalog — **3 ore**
Scripturile de import AliExpress există, storage-ul merge acum.
- Rulează importul, verifică clasificarea pe verticale
- Pornește pipeline-ul video (AE → ffmpeg → HLS → MinIO)
- **Impact:** feed-ul are ce afișa; fără produse totul pare mort

### B3. Stripe — **1 oră**
Webhook-ul există deja (`/api/webhooks/stripe`).
- Chei live + conectare la checkout și la donații
- **Impact:** momentan doar cash la livrare, zero comisioane încasate

---

# 🟠 ȘABLOANE DE PAGINI — inima muncii

Fiecare șablon se scrie o dată și acoperă mai multe verticale, parametrizat din `catalog.ts`.

### P1. Șablon `order` — generalizează pagina Food · **1 zi**
`/food` funcționează. Trebuie extras într-un component parametrizabil pentru Market, Pharma, Flowers, Drinks, Send.
- [ ] `components/verticals/OrderVerticalPage.tsx` (listare comercianți)
- [ ] `components/verticals/MerchantMenuPage.tsx` (catalog + coș)
- [ ] Rute: `/market`, `/pharma`, `/flowers`, `/drinks`, `/send`
- [ ] Etichete specifice per verticală (nu „bucătărie" la farmacie)

### P2. Șablon `lead` — 8 verticale · **2 zile**
Cel mai mare câștig: acoperă Estates, Auto, Pro, Learn, Care, Biz, Move, Jobs.
- [ ] Grilă de anunțuri cu filtre din `subcategories` + `fields` (registry)
- [ ] Pagină de anunț: galerie, atribute, hartă, **buton contact**
- [ ] Formular lead → `/api/inquiries` (există)
- [ ] Filtre specifice: preț, cameră, suprafață (imobiliare) / an, km, combustibil (auto)

### P3. Șablon `booking` — 9 verticale · **2 zile**
Două sub-tipuri:
- **pe nopți** (Stays, Trips, Rentals): calendar interval + preț/noapte → `/api/stays/bookings`
- **pe intervale orare** (Salon, Health, Fit, Service): sloturi de 30 min
- [ ] `components/booking/DateRangePicker.tsx` (zile ocupate din API)
- [ ] `components/booking/SlotPicker.tsx`
- [ ] ⚠️ **Lipsește API** pentru rezervări pe sloturi orare — trebuie tabelă nouă

### P4. Pagina `/cares` — donații · **1 zi**
API-ul există (`/api/campaigns`, `/api/donations`).
- [ ] Listă campanii cu bară de progres
- [ ] Pagină campanie: poveste, **defalcare buget**, plăți cu dovezi, donatori recenți
- [ ] Sume rapide (10/25/50/100 lei) + sumă liberă + donație anonimă
- [ ] Rotunjire la checkout („adaugi 2 lei pentru o familie?")

---

# 🟠 PANOURI — ca oamenii să se descurce singuri

### A1. Panou merchant (restaurant) · **2-3 zile**
Fără el, restaurantele nu-și pot gestiona nimic.
- [ ] `/seller/merchant` — date, program pe zile, taxe, rază livrare
- [ ] Editor meniu: categorii, articole, opțiuni cu preț, disponibilitate
- [ ] **Comenzi live** cu sunet: acceptă/refuză → în pregătire → gata
- [ ] Buton „închid acum" (`is_open_override`)
- [ ] ⚠️ **Lipsește API**: `GET /api/merchants/[id]/orders`

### A2. PWA curier · **2-3 zile**
- [ ] `/courier` — înrolare cu documente
- [ ] Comutator online/offline + trimitere GPS la 10s (`/api/couriers/status` există)
- [ ] Ofertă de livrare cu numărătoare inversă 45s → accept/refuz
- [ ] Navigare: ridicare → livrare, butoane de stare
- [ ] Istoric + câștiguri

### A3. Panou cauze (Cares) · **1 zi**
- [ ] Înregistrare cauză cu documente de verificare
- [ ] Creare campanie: țintă, poveste, defalcare buget
- [ ] Raportare cheltuieli cu dovadă (foto factură)
- [ ] ⚠️ **Lipsesc API-uri**: `/api/causes`, `/api/campaigns/manage`

### A4. Panou admin — moderare · **2 zile**
- [ ] `/admin/merchants` — aprobare restaurante (sunt `pending` la creare!)
- [ ] `/admin/couriers` — verificare documente curieri
- [ ] `/admin/donations` — verificare cauze, aprobare plăți
- [ ] Fără astea, **nimic nu poate fi aprobat** — totul rămâne blocat în `pending`

### A5. Panou cazări · **1 zi**
- [ ] `/seller/stays` — publicare, calendar disponibilitate, prețuri sezoniere
- [ ] ⚠️ **Lipsește API**: `/api/stays/availability` (setare zile blocate/prețuri)

---

# 🟡 API-URI LIPSĂ (confirmate prin scanare)

| API | Pentru ce | Efort |
|---|---|---|
| `GET /api/merchants/[id]/orders` | panoul de comenzi al restaurantului | 2 h |
| `POST /api/stays/availability` | gazda blochează zile / pune preț sezonier | 2 h |
| `POST /api/causes` | înregistrare beneficiar donații | 2 h |
| `POST/PATCH /api/campaigns/manage` | creare și editare campanii | 3 h |
| `POST /api/upload` | upload imagini din panouri (MinIO e gata) | 3 h |
| `POST /api/bookings/slots` | rezervări pe ore (salon, medic) + tabelă nouă | 1 zi |

---

# 🟡 CALITATE

- [ ] **29 rute fără `try/catch`** → returnează 500 generic (3-4 h)
- [ ] **5 vulnerabilități `high`** în `sharp`/libvips — fix breaking, cere testare (2 h)
- [ ] **1.135 de `: any`** — TypeScript nu prinde erori acolo (continuu)
- [ ] **Zero teste automate** pentru fluxurile critice: checkout, dispatch, rezervări (1 săpt.)
- [ ] Monitorizare erori în producție (Sentry sau echivalent) (3 h)
- [ ] Backup automat al bazei Swypik (există doar pentru ERP) (2 h)

---

# 🔵 STRATEGIC — după ce ai utilizatori

- [ ] **ERP multi-tenant** — fiecare seller primește ERP configurabil (3-4 săpt.)
      Baza există în Meister: `tenants`, `modules_enabled`, `plan`
- [ ] **Puncte SWY** — `wallet_ledger` există deja; devine baza tokenului (1 săpt.)
- [ ] **Distribuție echitabilă** — rotație în feed, boost pentru începători, plafon per business (1 săpt.)
- [ ] **Comision în trepte** 0% → 8% + abonamente ERP (1 săpt.)
- [ ] Token pe Base/Polygon — doar după tracțiune reală, atenție la MiCA

---

# Ordinea recomandată

> Decizie (30 iul): **emailul (B1) se lasă LA URMĂ** — fluxurile se construiesc și se
> testează fără el (emailul e no-op în lipsa cheilor, nu blochează nimic tehnic).

**Ziua 1** — B2 (produse) → feed-ul are conținut
**Zilele 2-4** — P2 (șablon lead, 8 verticale) + P4 (Cares)
**Zilele 5-7** — A4 (admin moderare) + A1 (panou merchant)
**Săptămâna 2** — P1 (order), P3 (booking), A2 (PWA curier), B3 (Stripe)
**Săptămâna 3** — calitate: teste, try/catch, monitorizare
**La final** — B1 (email) + ERP multi-tenant

---

# Împărțire pe doi agenți

| | Agent A (backend) | Agent B (frontend) |
|---|---|---|
| **Zone** | `app/api/`, `lib/`, `db/migrations/`, VPS | `app/[locale]/`, `components/`, `messages/` |
| **Primele task-uri** | API-urile lipsă, B1, B2, B3 | P2 (lead), P4 (cares), apoi P1, P3 |
| **Nu atinge** | componente UI | migrații, rute API |

**Reguli:**
1. Branch propriu, merge în `main` prin PR
2. `lib/verticals/catalog.ts` și `lib/validation/schemas.ts` — se ating **doar cu anunț**
3. Migrațiile le scrie **doar Agent A**
4. `npm run ci` verde înainte de push
5. Migrațiile se testează pe `swypik_dev` înainte de producție
