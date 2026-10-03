# Deviz Swypik — stare la 30 iulie 2026

> **Repo:** https://github.com/office233/swypik-commerce-platform
> **ERP:** https://github.com/office233/meistercom-erp
> **Producție:** swypik.com · VPS 178.105.46.66 · **Mediu de lucru: `E:\Meister\swypik\app`**

---

## Regula de aur

**Se lucrează LOCAL → git push → deploy pe VPS.** Nu se editează direct pe server.
Detalii și comenzi în `DEV.md`.

---

# PARTEA I — Ce este făcut

## 1. Infrastructură ✅

| Componentă | Stare |
|---|---|
| VPS Hetzner (7.6 GB RAM, 75 GB disc) | 17 containere, 51% disc, 3.5 GB RAM |
| Postgres producție (`swypik_prod`) | 151 tabele, izolat de ERP |
| Postgres dev (`swypik_dev`) | clonă de schemă, fără date reale |
| Redis | activ |
| MinIO (storage S3) | `cdn.swypik.com`, bucket public |
| 3× video-worker (ffmpeg → HLS) | healthy |
| nginx + Cloudflare | Origin Certificate valabil până în 2041 |
| Separare de ERP | rețele, baze de date și repo-uri distincte |

## 2. Backend ✅

**231 rute API**, `TS: 0` erori, 111 migrații, 364 commituri.

Auditat pe producție:
- toate rutele protejate răspund **401** fără sesiune
- injecție SQL → tratată ca text (parametrizare peste tot)
- input invalid → **400** cu mesaj clar
- rate limiting activ (**5 × 429** din 10 cereri rapide)
- toate cele 5 headere de securitate prezente
- **266 constrângeri CHECK**, 52 chei străine, 229 indexuri
- constrângere **EXCLUSION** care face dubla-rezervare imposibilă fizic

**Module funcționale:**

| Modul | Endpoint-uri | Ce face |
|---|---|---|
| Marketplace | `/api/products`, `/api/cart`, `/api/checkout` | coș + checkout, prețuri server-side |
| Anunțuri | `/api/listings`, `/api/inquiries` | publicare + lead-uri |
| Food | `/api/merchants`, `/api/merchants/[id]/menu`, `/api/local-orders` | restaurante, meniuri cu opțiuni, comenzi |
| Dispatch | `/api/local-orders/[id]/dispatch` | ofertă la 5 curieri, `FOR UPDATE` atomic |
| Curieri | `/api/couriers`, `/api/couriers/status` | înrolare, GPS live |
| Cazări | `/api/stays/bookings` | rezervări + calendar |
| Donații | `/api/campaigns`, `/api/donations` | campanii + transparență plăți |
| Feed | `/api/feed/universal` | algoritmic, ponderat pe ora zilei |
| ERP Connect | `/api/seller/erp/*` | sincronizare catalog din Meister ERP |

## 3. Frontend ✅

- **32 de verticale** configurate declarativ în `lib/verticals/catalog.ts`
- Homepage refăcut: 4 carduri-erou + grupe tematice, culori semnătură
- `/food` + `/food/[slug]` — flux complet de comandă
- `/v/[id]` — pagină per verticală cu subcategorii
- i18n în **7 limbi**
- Navigare simplificată: Acasă · Explorează · ➕ · Mesaje · Profil

## 4. Reparat în ultimele zile ✅

- 21 erori TypeScript în modulul ERP (dbQuery tratat greșit ca array)
- Bară de navigare duplicată
- Icoane PWA — middleware-ul i18n le prefixa cu limba → 404
- Produse „fantomă" din localStorage
- 38 GB spațiu disc recuperat
- Certificat SSL ERP (Let's Encrypt nu se mai putea reînnoi din cauza Cloudflare Access)
- Curățenie: 2 componente moarte, 21 scripturi arhivate

---

# PARTEA II — Ce urmează

## 🔴 BLOCANTE — fără ele nu poți avea utilizatori

| # | Ce | Efort | De ce |
|---|---|---|---|
| 1 | **Credențiale email** (SMTP IONOS sau Resend) | 10 min | Codul e gata (transport dual). Fără el **nimeni nu se poate înregistra**. |
| 2 | **Import produse** | 2-3 h | Scripturile AliExpress există, storage-ul e gata. Fără produse, feed-ul e gol. |
| 3 | **Stripe** (chei live) | 1 h | Fără plăți: doar cash la livrare, zero comisioane. |

## 🟠 FUNCȚIONALITATE — pagini care lipsesc

| # | Ce | Efort |
|---|---|---|
| 4 | `/cares` — campanii donații (API-ul există) | 1 zi |
| 5 | `/stays` — cazări + calendar rezervare | 1-2 zile |
| 6 | `/listings` — anunțuri imobiliare/auto cu filtre | 1-2 zile |
| 7 | `/courier` — PWA cu GPS pentru livratori | 2-3 zile |
| 8 | Panou merchant — restaurantul își gestionează meniul și comenzile | 2-3 zile |
| 9 | Formulare de publicare pentru verticalele `booking` și `donation` | 2 zile |

## 🟡 CALITATE

| # | Ce | Efort |
|---|---|---|
| 10 | 29 rute fără `try/catch` → 500 generic în loc de mesaj clar | 3-4 h |
| 11 | 5 vulnerabilități `high` în `sharp` (fix breaking) | 2 h + testare |
| 12 | 1.135 de `: any` — TypeScript nu prinde erori acolo | continuu |
| 13 | Teste automate pentru fluxurile critice | 1 săpt. |

## 🔵 STRATEGIC — după ce ai utilizatori

| # | Ce | Efort |
|---|---|---|
| 14 | **ERP multi-tenant** — fiecare seller primește ERP configurabil | 3-4 săpt. |
| 15 | Sistem de puncte SWY (bază pentru token) | 1 săpt. |
| 16 | Algoritm de distribuție echitabilă (niciun business nu falimentează) | 1 săpt. |
| 17 | Comision în trepte (0% → 8%) + abonamente | 1 săpt. |
| 18 | Token pe Base/Polygon | după tracțiune |

---

# PARTEA III — Realitatea din producție

```
marketplace_products      0      ← platforma e goală
videos                    0
users                     3      (conturi de test)
sellers                   0
local_merchants           0
taxonomy_nodes          121      ← structura există
```

**Concluzie:** infrastructura și codul sunt solide și auditate. Ce lipsește nu e calitate tehnică, ci **conținut și chei de acces**.

---

# Ordinea recomandată

**Săptămâna 1 — fă platforma vie**
1. Email (10 min) → oamenii se pot înregistra
2. Import produse (3 h) → feed-ul are ce arăta
3. `/cares` + `/stays` + `/listings` → toate verticalele au pagini

**Săptămâna 2 — închide buclele**
4. Panou merchant → restaurantele se descurcă singure
5. PWA curier → livrările funcționează cap-coadă
6. Stripe → încasezi comisioane

**Săptămâna 3+ — scalează**
7. ERP multi-tenant (pilot: Meister Com ca prim seller)
8. Puncte SWY + gamificare

---

## Împărțire pe doi agenți

Dacă lucrezi cu încă un agent, separarea curată e:

| Agent | Zonă | Fișiere |
|---|---|---|
| **A** | Backend + infra + date | `app/api/`, `lib/`, `db/migrations/`, VPS |
| **B** | Frontend + UI | `app/[locale]/`, `components/`, `messages/` |

Reguli ca să nu vă călcați:
- fiecare pe **branch propriu**, merge în `main` prin PR
- `lib/verticals/catalog.ts` și `lib/validation/schemas.ts` se ating **doar cu anunț** (sunt sursa de adevăr partajată)
- migrațiile le scrie **doar un agent** (conflictele de schemă sunt greu de reparat)
- `npm run ci` verde înainte de orice push
