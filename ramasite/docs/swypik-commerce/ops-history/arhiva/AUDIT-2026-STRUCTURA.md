# Swypik — Plan de restructurare (audit 2026)

**Scop:** o structură pe care un dezvoltator nou (sau un agent) o poate citi corect din prima, fără să
editeze cod mort și fără să ghicească unde stă adevărul.
**Constrângere:** swypik.com e în producție. Nimic din acest plan nu e o rescriere. Fiecare etapă se
termină cu `tsc --noEmit` = 0, `next build` = SUCCES, `vitest run` = verde.

**Baseline verificat empiric (2026-09-14):**
`tsc --noEmit` 0 erori · `next build` SUCCES · `next lint` 0 erori / 637 warnings · `vitest run` 126 PASS.
Nu există erori de compilare. Toate problemele de mai jos trec de build — de asta au supraviețuit.

**Dimensiuni reale, pentru calibrare:** 837 fișiere `.ts`/`.tsx` în `app/` + `lib/` + `components/`,
315 rute `route.ts` (din care 31 cron), 171 migrări SQL, 126 teste unitare, 63 subdirectoare `lib/`.

**Notă de securitate rămasă deschisă (nu e de structură, dar blochează etapa 4):**
orice `POST`/`PUT`/`DELETE` anonim către `/api/v1/*` ajunge încă la serviciul Go cu
`X-Swypik-Internal-Secret` atașat. În Go, `requiresInternalAuth` cere `true` pentru orice metodă
non-GET, iar secretul e **singura** autorizare. E nevoie de o listă albă de căi publice sau de
verificare de sesiune în catch-all, înainte ca orice reorganizare a proxy-ului `/api/v1` să fie sigură.

---

## 1. Structura țintă

Structura țintă este structura de azi, **curățată** — nu una nouă. Directoarele de top nivel rămân
aceleași; se schimbă regulile de apartenență și se elimină locurile unde același lucru există de
două ori.

```
E:/Swypik/swypik/app/                 (rădăcina repo-ului Next.js)
│
├── app/                              # DOAR rutare Next. Nimic care nu e pagină sau endpoint.
│   ├── layout.tsx  globals.css  error.tsx  global-error.tsx  not-found.tsx
│   │
│   ├── [locale]/                     # TOATE paginile publice, fără excepție
│   │   ├── page.tsx                  # home
│   │   ├── categories/ product/ search/ explore/ shop/ collections/ best/
│   │   ├── cart/ checkout/ orders/ account/ pay/
│   │   ├── stays/ fly/ go/ food/ live/ reels/ video/ v/ audio/ post/ u/ b/
│   │   ├── swyp/ missions/ inbox/ messages/ notifications/
│   │   ├── causes/                   # ← fuziunea /cauze (RO) + /cares (EN)
│   │   ├── join/{creator,seller,host,fleet,franchise}/   # ← toate pâlniile de înrolare
│   │   └── legal/ privacy/ terms/ help/ about/
│   │
│   ├── admin/ seller/ creator/ courier/ auth/ onboarding/ developers/ apps/
│   │                                 # Portaluri autentificate, nelocalizate.
│   │                                 # Fiecare nume de aici TREBUIE să fie în NON_LOCALIZED_PREFIXES
│   │                                 # și nu are voie să existe și sub [locale]/.
│   │
│   ├── (seo)/                        # route group — nu schimbă URL-urile
│   │   ├── sitemap.xml/ static-sitemap.xml/ feed.xml/
│   │   ├── products/sitemap/ videos/sitemap.ts
│   │   └── r/[code]/ unsubscribe/
│   │
│   └── api/
│       ├── _lib/                     # helperi folosiți DOAR de rute (nu sunt domeniu)
│       ├── cron/                     # 31 de joburi, toate prin defineCronJob()
│       ├── internal/                 # apelate doar de workeri/servicii; gard pe secret intern
│       ├── v1/                       # contract public + proxy către Go (listă albă de căi)
│       ├── webhooks/                 # Stripe & furnizori
│       └── <domeniu>/                # plural, kebab-case, query params snake_case
│
├── components/                       # componente React folosite de ≥2 rute
│   └── <domeniu>/                    # home/ checkout/ social/ reels/ verticals/ i18n/ ...
│                                     # Componenta folosită de o singură rută rămâne colocată
│                                     # lângă acea rută (tiparul *Client.tsx există deja).
│
├── lib/                              # logică de domeniu, fără JSX
│   ├── db.ts logger.ts api-handler.ts redis.ts url.ts feature-flags.ts feature-flags-client.ts
│   │                                 # ↑ LISTĂ ÎNCHISĂ de module de infrastructură la rădăcina lib/.
│   │                                 #   Orice alt fișier nou la rădăcină = eroare de CI.
│   ├── auth/                         # SINGURUL modul care citește cookie-ul de sesiune
│   ├── security/                     # rate-limit, getClientIP, admin/seller auth, audit-log
│   ├── queries/                      # ← fostul lib/db/ (elimină coliziunea db.ts + db/)
│   ├── cron/                         # runCron + registry + defineCronJob
│   ├── checkout/ payments/ swyp/ wallet/ pricing/ stripe/ commerce/
│   ├── stays/ fly/ rides/ drivers/ dispatch/ fulfillment/ suppliers/ merchants/
│   ├── social/ reels/ video/ feed/ algo/ search/ moderation/ reviews/
│   ├── i18n/ seo/ email/ notifications/ push/ legal/ ops/ config/ storage/ ui/
│   └── ...
│
├── db/                               # SINGURA sursă de SQL versionat
│   ├── schema.sql
│   └── migrations/                   # NNNN unic, un singur ledger
│       └── baseline/                 # migrări nerejucabile, marcate .applied.sql
│
├── scripts/                          # unelte rulate de om sau de CI, grupate pe verb
│   ├── db/ ops/ deploy/ data/ dev/ diag/ i18n/
│   ├── audit/                        # ← fostul tools/*.sh, cu rădăcina derivată din locație
│   └── _archive/
│
├── services/platform-api/            # serviciu Go de sine stătător
├── workers/                          # procese out-of-process: Cloudflare (JS) + video/ai (Python)
├── infra/                            # configurație de infrastructură, nu cod de aplicație
│   ├── hetzner/ cloudflare/ clickhouse/ grafana/ kubernetes/ local/ observability/
│   └── chain/                        # ← fostul chain/ de la rădăcină
├── packages/contracts/               # contracte partajate Next ↔ Go (OpenAPI)
├── tests/
│   ├── unit/                         # vitest — singurul runner de teste de sursă
│   ├── e2e/                          # playwright, read-only, rulează pe producție
│   └── e2e-full/                     # playwright, scrie date, rulează pe stack local în CI
├── docs/
│   ├── *.md                          # documentație VIE
│   └── _archive/                     # rapoarte istorice, cu banner STALE <dată>
├── messages/  public/  types/
├── README.md  CLAUDE.md              # singurele .md de la rădăcină
└── middleware.ts  next.config.mjs  tsconfig.json  ...
```

### Justificare, un rând per director de top nivel

| Director | De ce există separat |
|---|---|
| `app/` | Rutare Next și atât. Tot ce nu e URL (helper, tip, query) nu are ce căuta aici — altfel nu mai poți citi harta de URL-uri dintr-un `ls`. |
| `components/` | Componente React refolosite; pragul de mutare aici e „≥2 rute”, ca să nu se umple cu fișiere cu un singur consumator care ar fi trebuit colocate. |
| `lib/` | Logică de domeniu fără JSX, importabilă și din rute, și din scripturi, și din teste — stratul care poate fi testat fără să pornești Next. |
| `db/` | Singura sursă de SQL versionat; azi există SQL rătăcit în `lib/db/01-create-sellers.sql` și în `scripts/db/*.sql`, iar asta face imposibilă întrebarea „ce s-a aplicat pe bază”. |
| `scripts/` | Ce rulează un om sau CI-ul, nu serverul. Separat de `lib/` pentru că `tsconfig.json` deja exclude `scripts` — deci codul de aici nu e verificat de `tsc` și nu trebuie să ajungă în runtime. |
| `services/` | Procese cu ciclu de viață și limbaj propriu (Go), cu propriul `go.mod` și propriile teste în CI. |
| `workers/` | Procese out-of-process (Cloudflare, Python) care consumă cozi; separate de `services/` pentru că nu expun API și nu au contract public. |
| `infra/` | Configurație de mașină (compose, Caddy, systemd, cron-worker, DNS, chain). Nu se importă niciodată din aplicație; e directorul care se schimbă la deploy, nu la feature. |
| `packages/` | Contractul OpenAPI partajat între Next și Go — singurul artefact care are doi consumatori în două limbaje și de aceea nu poate sta în niciunul dintre ele. |
| `tests/` | Teste care nu sunt colocate (e2e, teste de structură, teste de invariant). Azi există patru sisteme paralele de test; directorul ăsta devine singurul loc unde se caută. |
| `docs/` | Documentație vie; `_archive/` există ca să poți șterge din calea de citire un raport vechi fără să-l pierzi din istoric. |
| `messages/` | Traduceri, sursa de adevăr pentru textele afișate — singurul loc unde româna are voie să apară. |
| `types/` | Tipuri cu consumatori din ≥2 straturi (rute + componente). Tipul cu un singur consumator stă lângă el. |
| `public/` | Active statice servite ca atare; niciodată cod. |

### Ce e diferit față de azi (pe scurt)

1. **Zero nume duplicat între `app/` și `app/[locale]/`.** Azi `categories/` și `r/` există în ambele.
2. **Un singur termen per funcționalitate.** Azi aceeași funcție e `/cauze`, `/cares` și `/api/causes`.
3. **`lib/db.ts` și `lib/db/` nu mai coexistă** (414 importuri de `@/lib/db` depind de o rezolvare ambiguă).
4. **`tools/` dispare** în `scripts/audit/` — azi cinci scripturi de audit fac `cd` într-un snapshot mort din 5 august.
5. **`chain/` intră în `infra/`** — e configurație de infrastructură, nu cod de aplicație.
6. **Rădăcina repo-ului are 2 fișiere `.md`, nu 5** — azi `DEV.md` și `DEVIZ.md` trimit deploy-ul și migrările către un host dezafectat.
7. **`lib/` are o listă închisă de fișiere la rădăcină**, impusă de un test.

---

## 2. Migrarea, pe etape

Fiecare etapă e un PR separat, mic, cu build verde la final. Ordinea contează: etapele 1–3 sunt
aproape fără risc și pregătesc terenul; 4–7 ating comportament și au nevoie de verificare pe staging.

**Verificarea standard**, la finalul fiecărei etape (numită mai jos „verificarea standard”):

```bash
npm run typecheck          # tsc --noEmit → 0 erori. Prinde ORICE import rupt de o mutare.
npm run lint               # 0 erori (warnings pot crește, nu scădea sub 637)
npm test                   # vitest run → toate verzi
npm run build              # next build → SUCCES; compară lista de rute cu cea de dinainte
git diff --stat            # majoritatea liniilor trebuie să fie renames (git detectează R100)
```

Plus, pentru etapele care ating rutarea, un pas manual obligatoriu:

```bash
npm run build 2>&1 | grep -E "^[├└│ ]*[○ƒ]" | sort > /tmp/routes-after.txt
diff /tmp/routes-before.txt /tmp/routes-after.txt    # trebuie să fie exact ce ai intenționat
```

---

### Etapa 0 — Îngheață baza

**Ce faci:** comite cele 69 de fișiere modificate de pe `fix/audit-swypik` (inclusiv cele 4 reparații
de securitate deja verificate: poarta de admin cu `await`, filtrul de preț din `/api/listings`,
`headers.delete` în `lib/social/proxy.ts`, gardul 404 pe `/v1/admin/*`).

**De ce prima:** o mutare de fișier peste modificări necomise nu se mai poate citi ca rename în
`git diff`. Dacă etapele următoare se amestecă cu munca de audit, review-ul devine imposibil și
un revert ia cu el și reparațiile bune.

**Verificare:** verificarea standard înainte de commit. Salvează `/tmp/routes-before.txt` acum.

---

### Etapa 1 — Ștergeri pure (cod care nu se execută niciodată)

Cea mai mare rată de câștig pe unitatea de risc: nimic din ce se șterge aici nu rulează în producție.

**1.1 `app/categories/` — furcă moartă.**
`middleware.ts` rescrie mereu `/categories/*` către varianta `[locale]`, deci
`app/categories/[slug]/page.tsx` nu se execută niciodată. Cele două fișiere au **deja divergat**:
varianta moartă construiește base URL-ul manual din headere, varianta vie folosește
`getRequestBaseUrl`; varianta vie are `languagesForMetadata` pentru hreflang, cea moartă nu.
Două fixuri (contrast și base URL) au fost aplicate doar în varianta vie.

```bash
rm -rf "app/categories"
```

**1.2 `app/[locale]/r/[code]/` — al doilea link de referral, cu alt comportament.**
`"/r"` e în `NON_LOCALIZED_PREFIXES`, deci `/r/CODE` merge la `app/r/[code]/route.ts` (cookie 30 de
zile, redirect la înregistrare cu codul precompletat). `app/[locale]/r/[code]/route.ts` e accesibil
la `/ro/r/CODE` și face **altceva**: `setReferralCookie` 90 de zile, redirect la home. Două
comportamente de atribuire pentru același tip de link.

Verifică întâi ce URL e efectiv tipărit pe QR-urile șoferilor și în emailuri:

```bash
grep -rn '"/r/\|`/r/\|/ro/r/' app lib components messages public
```

Apoi păstrează **unul** și fă-l pe celălalt redirect 301 în `next.config.mjs`. Ipoteza de lucru:
`app/r/[code]` e cel viu (e în lista de prefixe nelocalizate); mută-l în `app/(seo)/r/[code]/` la
etapa 4 și șterge varianta din `[locale]`.

**1.3 `rateLimit` și `clientIp` din `lib/rate-limit.ts`.**
`rateLimit` are **zero importatori** și cade *deschis* la eroare de Redis — inversul implementării
reale din `lib/security/rate-limit.ts`, care cade închis. Cine îl auto-importează dintr-un fișier cu
numele ăsta dezactivează tăcut limitarea pe ruta lui. `clientIp` are 2 importatori
(`app/api/checkout/create-intent/route.ts:10`, `app/api/missions/[slug]/submit/route.ts:11`) și
codifică aceeași premisă de trust boundary ca helperul canonic, dar în alt fișier — deci o corecție
viitoare de ingress îl va rata exact pe cel de pe checkout.

```bash
grep -rn "from \"@/lib/rate-limit\"" app lib components    # trebuie să rămână 2, apoi 0
```

Șterge ambele funcții, redirecționează cei 2 importatori spre `getClientIP` din
`@/lib/security/rate-limit`, apoi redenumește ce rămâne (doar helperi de idempotență) în
`lib/idempotency.ts`, ca numele fișierului să nu mai atragă importuri greșite.

**1.4 Cele 4 migrări duplicate byte-identic.**
`20260514_direct_messages.sql`, `20260514_order_item_payout_status_check.sql`,
`20260514_push_notifications.sql`, `20260514_search_indexes.sql` există și în variantă cu `NNNN`
(`_0002`/`_0003`/`_0004`/`_0005`). Pentru că versiunea = numele fișierului, sunt versiuni diferite în
ledger, se aplică de două ori și `tools/check-migration-drift.sh` iese permanent cu cod 3.

**Ordinea contează — întâi interoghează producția, apoi șterge:**

```sql
SELECT version FROM schema_migrations WHERE version LIKE '20260514%' ORDER BY 1;
SELECT filename FROM _applied_migrations WHERE filename LIKE '20260514%' ORDER BY 1;
```

Dacă în DB e înregistrată varianta cu `NNNN`, șterge fișierele fără `NNNN` și rândurile lor din
ledger. Dacă e înregistrată varianta fără, inserează întâi versiunea cu `NNNN`, apoi șterge.

**1.5 Scripturile de audit care rulează pe un snapshot din 5 august.**
Cinci fișiere din `tools/` fac `cd /mnt/e/Meister/...` — directorul chiar există, deci `cd` reușește
și raportul iese „curat” despre cod care nu mai rulează.

```bash
grep -rn "/mnt/e/Meister" tools/ scripts/ infra/
```

Înlocuiește calea hardcodată cu rădăcina derivată din locația scriptului (tiparul corect e deja în
`scripts/db/check-schema-drift.sh:30-31`):

```bash
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 1
```

**1.6 `scripts/i18n-guard.mjs:61` — calea de `--fix`.**
Gardianul blochează commit-ul și îți spune la linia 118 să rulezi `node scripts/i18n-guard.mjs --fix`,
care apelează `scripts/translate-messages.mjs` — fișier mutat la `scripts/data/translate-messages.mjs`
de reorganizarea din 19 august. Rezultatul: `MODULE_NOT_FOUND` raportat ca „verifică STUDIAI_API_KEY”,
iar dezvoltatorul ocolește hook-ul cu `--no-verify`, pierzând și verificarea de JSON corupt.
Corectează calea **și** verifică existența fișierului înainte de `execSync` (tiparul corect e deja
folosit pentru `SCANNER` la linia 92).

**Verificare etapa 1:** verificarea standard + `diff routes-before/after` (trebuie să dispară exact
rutele `/categories/[slug]` nelocalizată și `/[locale]/r/[code]`) + `bash tools/audit-security.sh`
rulat din două directoare diferite trebuie să dea același rezultat + `bash scripts/db/check-schema-drift.sh`
iese cu 0, nu cu 3.

---

### Etapa 2 — Un singur nume pentru fiecare primitivă partajată

Nu se mută fișiere aici; se elimină copiile. Etapa asta e condiția ca etapele următoare să nu
propage divergențe.

**2.1 Cookie-ul de sesiune — 7 declarații ale aceluiași literal.**

```
lib/auth/session.ts:21       export const SESSION_COOKIE = "swypik_session"   ← canonic
lib/auth/getAuthUser.ts:18   const SHOPPER_COOKIE = "swypik_session"
lib/auth/oauth/helpers.ts:12 const COOKIE_NAME = "swypik_session"
lib/creator/session.ts:21    store.get("swypik_session")
lib/social/session.ts:160    cookieStore.get("swypik_session")
app/api/auth/orders/route.ts:12  const COOKIE_NAME = "swypik_session"
app/api/auth/route.ts:45         const COOKIE_NAME = "swypik_session"
```

Importă `SESSION_COOKIE` din `@/lib/auth/session` în toate cele 6 locuri.

**2.2 Rezolverul de sesiune — 5 module citesc `user_sessions`.**
`lib/auth/getAuthUser.ts`, `lib/auth/session.ts`, `lib/auth/oauth/helpers.ts`,
`lib/creator/session.ts`, `lib/social/session.ts`. Consecințe deja constatate, nu ipotetice:
banul se aplică pe ~89 de rute și nu pe celelalte 40; Bearer-ul funcționează doar pe unele; rolul de
seller diferă în funcție de ce modul a importat ruta.

**Regula finală:** `lib/auth/session.ts` e singurul modul cu voie să citească cookie-ul de sesiune și
tabela `user_sessions`. `getAuthUser` se reimplementează *peste* `getAuthSession()`, păstrând doar
ramurile lui specifice (`admin_sessions`, `seller_sessions`, Bearer de `ADMIN_SECRET`) și maparea de
rol. `AuthRole` din `getAuthUser.ts:8` și tipul din `session.ts` devin un singur tip exportat dintr-un
singur loc.

**Dacă unificarea completă nu încape într-un PR:** pasul minim, imediat, e să exporți fragmentul SQL
de filtrare a statusului din `lib/auth/session.ts` (`ACTIVE_USER_SQL`) și să-l folosești în ambele
interogări. Rezolvă gaura de ban acum, unificarea rămâne pentru pasul următor.

**2.3 `getClientIP` — 12 extrageri locale de `x-forwarded-for`.**
Trei dintre ele iau **primul** hop, exact hopul pe care helperul canonic îl declară spoofabil:

```
app/api/merchants/apply/route.ts:39      app/api/fleet-partners/route.ts:29
app/api/swyp/mining/verify/route.ts:34   app/api/couriers/route.ts:25
app/api/donations/route.ts:26            app/api/inquiries/route.ts:23
app/api/videos/[id]/report/route.ts:48   app/api/auth/oauth/{apple,google}/callback/route.ts
lib/anon/session.ts:36                   lib/referral/attribution.ts:107
```

`getClientIP` din `lib/security/rate-limit.ts` are deja 142 de importatori — e canonicul de facto.
Înlocuiește cele 12, păstrând `createHash(...)` doar unde IP-ul e persistat.

**2.4 Formatterul de bani — 6 copii în verticala Stays, toate hardcodând RON.**

```
app/[locale]/stays/StaysClient.tsx:24-25        app/[locale]/stays/[id]/StayDetailClient.tsx:26
app/[locale]/stays/manage/HostBookings.tsx:28   app/[locale]/stays/manage/HostPanelClient.tsx:26
app/[locale]/account/stays/MyStayBookingsClient.tsx:25   lib/stays/notifications.ts:23-24
```

Toate aruncă câmpul `currency` primit, iar API-ul salvează rezervările implicit în EUR: un total de
450,00 EUR apare peste tot ca „450,00 RON”. Înlocuiește cu `formatMoneyCents(cents, currency, locale)`
din `lib/i18n/currency.ts` și adaugă `b.currency` în `SELECT`-ul din `loadBookingInfo`.

**2.5 Rata de comision creator — două variabile de mediu.**
`lib/config/commerce.ts:22` (ce se afișează) și `lib/creator/earnings.ts:2` (ce se plătește) citesc
env-uri diferite. O singură constantă, un singur env, importat din `lib/config/commerce.ts`.

**Verificare etapa 2:** verificarea standard, plus teste noi (vezi §3, garda `G4`) care fixează:
un user `banned` e anonim pe **ambele** rezolvere; `Authorization: Bearer` dă aceeași identitate ca
cookie-ul; `getClientIP` ignoră un `X-Forwarded-For` fabricat când ingress-ul apendează IP-ul real.
Plus o rulare de smoke pe staging cu un cont suspendat: `/api/apps/oauth/authorize`,
`/api/couriers/connect` și `/api/account/export` trebuie să refuze.

---

### Etapa 3 — `lib/`: elimină coliziunile și fișierele libere

**3.1 Coliziunea `lib/db.ts` + `lib/db/`.**
414 importuri de `@/lib/db` (`dbQuery`, `withTransaction`, `withAdvisoryLock`) depind de rezolvarea
fișier-înaintea-directorului. În ziua în care cineva adaugă `lib/db/index.ts` — reflexul normal când
un director are deja trei module înrudite — specificatorul devine ambiguu și cade tot stratul de date
dintr-o dată.

**Direcția ieftină, cea recomandată:** golește directorul, nu redenumi fișierul.

```
lib/db/product-queries.ts        → lib/queries/product-queries.ts
lib/db/feed-prefs.ts             → lib/queries/feed-prefs.ts
lib/db/category-filter-utils.ts  → lib/queries/category-filter-utils.ts
lib/db/01-create-sellers.sql     → db/migrations/  (sau ștergere, dacă e deja aplicată)
rmdir lib/db
```

**11 importatori** de actualizat (`@/lib/db/` → `@/lib/queries/`), față de **412** dacă ai redenumi
`lib/db.ts`. Aceeași siguranță, de 37 de ori mai puțină suprafață de diff.

Atenție: `app/api/categories/route.ts:10` folosește un **import dinamic**
(`await import("@/lib/db/product-queries")`) — `tsc` îl prinde, dar caută explicit și importurile
dinamice înainte de a declara etapa terminată:

```bash
grep -rn "import(\"@/lib/db" app lib components
```

**3.2 Fișierele libere de la rădăcina `lib/`, mutate în ordinea costului.**
Costul = numărul de importatori (măsurat, nu estimat):

| Fișier | Importatori | Destinație | Verdict |
|---|---:|---|---|
| `lib/rate-limit.ts` | 2 | `lib/idempotency.ts` | mută (etapa 1.3) |
| `lib/url.ts` | 3 | fuzionat cu `app-url.ts` | mută |
| `lib/topics.ts` | 5 | `lib/feed/topics.ts` | mută |
| `lib/health.ts` | 9 | `lib/ops/health.ts` | mută |
| `lib/contact.ts` | 12 | `lib/config/contact.ts` | mută |
| `lib/haptic.ts` | 14 | `lib/ui/haptic.ts` | mută |
| `lib/redis.ts` | 16 | rămâne la rădăcină | **listă închisă** |
| `lib/feature-flags-client.ts` | 5 | rămâne | **listă închisă** |
| `lib/feature-flags.ts` | 21 | rămâne | **listă închisă** |
| `lib/app-url.ts` | 51 | fuzionat în `lib/url.ts` | mută |
| `lib/api-handler.ts` | 102 | rămâne | **listă închisă** |
| `lib/logger.ts` | 260 | rămâne | **listă închisă** |
| `lib/db.ts` | 412 | rămâne | **listă închisă** |

Două helpere de URL (`url.ts` cu 3 importatori, `app-url.ts` cu 51) sunt o sursă activă de bug-uri —
varianta moartă a paginii de categorie construia base URL-ul manual tocmai pentru că nu era clar care
e canonicul. Păstrează numele `lib/url.ts` (mai general), mută în el `APP_URL` și `getRequestBaseUrl`,
codemod pe 51 de importuri, șterge `app-url.ts`.

Restul (`logger`, `db`, `api-handler`, `redis`, `feature-flags*`) **rămân la rădăcină** ca listă
închisă documentată. Nu pentru că locul e ideal, ci pentru că mutarea a 774 de importuri nu cumpără
nimic ce nu cumpără deja regula de CI din §3.

**Verificare etapa 3:** `tsc --noEmit` e suficient și complet pentru mutările de module —
orice specificator rupt e eroare de compilare. Plus `npm run build` (importurile dinamice și
`next/dynamic` nu sunt toate acoperite de `tsc`) și `grep -rn "@/lib/db/\|@/lib/app-url\|@/lib/topics\|@/lib/haptic\|@/lib/contact\|@/lib/health" app lib components` → 0 rezultate.

---

### Etapa 4 — Un singur nume public per funcționalitate

Prima etapă care schimbă URL-uri. Regulă absolută: **niciun URL public nu dispare fără redirect 301**.

**4.1 `/cauze` + `/cares` + `/api/causes` → `causes`.**
Aceeași funcționalitate în trei limbi. Un utilizator german care ajunge pe `/cares` și dă click spre
panoul cauzei lui aterizează pe `/cauze` — URL românesc, `metadata.title = "Panou cauze — Swypik"`,
servit fără traducere pentru că `middleware.ts:34` îl exclude explicit din next-intl. Nu poate fi
localizat fără să muți directorul. În plus, `/cauze` nu e în `app/static-sitemap.xml/route.ts`, deci
funcția e invizibilă pentru indexare.

```
app/cauze/            → app/[locale]/causes/panel/    (CausesPanelClient.tsx la fel)
app/[locale]/cares/   → app/[locale]/causes/          (page.tsx public)
middleware.ts:34      − "/cauze"
next.config.mjs       + redirects permanente: /cauze → /causes, /cares → /causes
static-sitemap        + "/causes"
```

Româna rămâne doar ca text de brand în `messages/*.json` („Swypik Cares”).

**4.2 Pâlniile de înrolare — 4 forme de nume, 2 uitate din sitemap.**
`/become-a-creator`, `/become-a-seller`, `/join/host`, `/join/fleet`, `/join/franchise`.
Cele trei sub `/join/` nu sunt trimise nici în sitemap, nici la IndexNow, nici la Bing — trei pâlnii
de achiziție de parteneri invizibile pentru motoare, și nimeni nu observă pentru că `/become-a-*`
apar corect.

**Ordinea contează, pentru că `/become-a-*` au deja capital SEO:**
1. **Imediat, zero risc:** adaugă `/join/host`, `/join/fleet`, `/join/franchise` (plus `/stays`,
   `/fly`, `/go`, `/causes`) în listele de SEO. Asta rezolvă 90% din pagubă.
2. **Apoi, structural:** extrage `lib/seo/static-paths.ts` importat de toate cele trei consumatoare —
   `app/static-sitemap.xml/route.ts`, `app/api/cron/indexnow/route.ts`,
   `app/api/cron/bing-url-submit/route.ts` — ca listele să nu mai poată diverge.
3. **Abia la urmă, opțional:** consolidează sub `app/[locale]/join/{creator,seller,host,fleet,franchise}`
   cu redirect 301 de la `/become-a-*`. Un redirect 301 transferă capitalul de link, dar costă câteva
   săptămâni de tranziție în Search Console. Dacă `/become-a-*` au trafic organic real, **amână** —
   câștigul e strict de consistență.

**4.3 Parametrii de query — două convenții în același domeniu.**
`components/home/OffersFeed.tsx:27` trimite `minPrice`; `/api/listings` citește `min_price`.
`Number(null)` = 0, deci filtrul e ignorat **tăcut**: userul cere „preț minim 500” și primește
produse de 20 de lei. (Cazul gemene din `/api/listings` a fost deja reparat cu gardă pe șirul brut;
aici e vorba de convenție, nu de coerciție.)

Fixează **snake_case** pentru toți parametrii (majoritatea existentă: `product_id`, `session_id`,
`parent_comment_id`, `include_soft_commerce`). Extrage `lib/api/query-params.ts` cu
`getNumber(url, name)` / `getBool(url, name)` care acceptă **un singur** nume canonic — aliasurile
sunt exact mecanismul care a lăsat divergența să supraviețuiască. Redenumește în
`app/api/products/route.ts`: `minPrice`→`min_price`, `maxPrice`→`max_price`,
`categoryId`→`category_id`, `includeCount`→`include_count`, și actualizează apelanții
(`components/home/OffersFeed.tsx:27`, `lib/queries/product-queries.ts`).

**4.4 Singular/plural în `app/api` — regula pentru viitor, nu renaming în masă.**
Azi: `creator/` (10 rute) lângă `creators/[id]`, `host/` (5) lângă `hosts/apply`, `seller/` (14)
fără `sellers/`, `couriers/` (6), `fleet-partners/`, `partner/`. Un dezvoltator care adaugă un
vertical nou nu are unde să se uite, iar un `fetch("/api/host/apply")` scris din memorie dă 404 în
loc de eroare de compilare.

**Nu redenumi cele 315 de rute.** Regula se aplică *de acum înainte* (§3, `C3`) și se impune prin
test. Consolidează acum **doar** endpoint-urile de `apply`, care sunt puține și au apelanți
exclusiv interni:

```
app/api/creator/apply/   → app/api/creators/apply/
app/api/hosts/apply/     (rămâne — deja plural)
app/api/fleet-partners/  → app/api/fleet/apply/
```

Pentru fiecare mutare, lasă **o singură versiune** ruta veche ca shim, apoi șterge-o:

```ts
// app/api/creator/apply/route.ts  — DEPRECAT, se șterge la 2026-10-15
export { POST } from "../../creators/apply/route";
```

**Verificare etapa 4:** `diff routes-before/after` e obligatoriu aici. Plus:
`curl -sI https://staging/cauze` → 301 către `/ro/causes`;
`curl -s "https://staging/static-sitemap.xml" | grep -c "join/host"` → ≥1;
test unitar care asertează că `lib/seo/static-paths.ts` e singurul loc cu literale de cale statică
(vezi garda `G5`). Și **nu** face etapa 4 înainte ca gaura de `/api/v1/*` non-GET să fie închisă —
orice atingere a proxy-ului acum mărește suprafața.

---

### Etapa 5 — Un singur runner de migrări, un singur ledger

Cea mai periculoasă zonă din repo. **Etapa asta se testează pe un dump restaurat, niciodată direct pe
producție.**

**Starea de azi:**
- Două runnere: `infra/hetzner/run-migrations.sh` (ledger `_applied_migrations`) și
  `scripts/db/apply-migration.sh` (ledger `schema_migrations`).
- Plus `scripts/db/run-remaining-migrations.sh`, `run-todays-migrations.sh`,
  `apply-local-migrations.mjs`, `apply-migration.mjs`, `apply-migration-local.ts`.
- Pe o bază migrată prin `apply-migration.sh`, `_applied_migrations` nu există; prima rulare a
  runnerului din `infra/` îl creează gol și **reaplică de la zero toate cele 171 de fișiere**, în
  ordine lexicografică — inclusiv backfill-uri (`20260514_0001_backfill_customers_to_users.sql`) și
  migrări distructive (`20260731_0001_drop_points_systems.sql`, `20260801_0001_drop_trends_battles.sql`).
- `-maxdepth 1` sare peste cele 17 migrări din `db/migrations/baseline/*.applied.sql`, mutate acolo
  tocmai pentru că nu se pot rejuca — deci starea rezultată nici măcar nu e reproductibilă.
- `infra/hetzner/deploy.sh:71` reaplică toate migrările la **fiecare** deploy, fără să consulte
  vreun ledger.
- `docs/DATABASE_CONVENTIONS.md:45` și `CLAUDE.md:112` indică `schema_migrations` — unde sunt ~28 de
  intrări din 171. Un operator care urmează documentația concluzionează că 143 de migrări n-au rulat.

**Pașii, în ordine:**

1. **Inventar, înainte de orice cod.** Pe un dump de producție restaurat local:
   ```sql
   SELECT version FROM schema_migrations ORDER BY 1;
   SELECT filename FROM _applied_migrations ORDER BY 1;
   ```
   Compară cu `ls db/migrations/*.sql db/migrations/baseline/*.sql`. Produce un tabel cu trei
   coloane: fișier / în `schema_migrations` / în `_applied_migrations`.
2. **Alege ledgerul.** `_applied_migrations` e cel populat de runnerul folosit efectiv la deploy;
   `schema_migrations` e relicvă parțială. Alege-l pe primul ca sursă de adevăr **sau** pe al doilea
   și fă backfill — dar decide și scrie decizia în `docs/DATABASE_CONVENTIONS.md` înainte de a atinge
   un script.
3. **Backfill ledgerul ales** cu toate migrările deja aplicate (inclusiv `baseline/`), pe dump.
   Normalizează formatul `version`: azi unele migrări scriu `'20260514_0004'`, altele
   `'20260514_0004_feed_events_check_restore'`, deci nici cele înregistrate nu se pot compara cu
   numele de fișier. **Versiunea = numele complet al fișierului, fără extensie.**
4. **Un singur runner.** Păstrează `scripts/db/apply-migration.sh`. Adaugă
   `scripts/db/apply-all-pending.sh` care iterează fișierele sortate și apelează `apply-migration.sh`
   pentru fiecare — ca să existe un flux batch **fără** ledger paralel.
5. **Șterge** `infra/hetzner/run-migrations.sh`, `scripts/db/run-remaining-migrations.sh`,
   `scripts/db/run-todays-migrations.sh`, `scripts/db/apply-local-migrations.mjs`. Păstrează
   `apply-migration-local.ts` strict pentru dev, redenumit explicit (`apply-migration.dev.ts`).
6. **Actualizează** `infra/hetzner/deploy.sh` să apeleze `apply-all-pending.sh`, nu bucla lui proprie.
7. **Actualizează documentația** în același PR: `docs/DATABASE_CONVENTIONS.md:43-46`, `CLAUDE.md:112`
   și regula 3 de la `CLAUDE.md:154`. Scoate afirmația „no collisions” — există 24 de coliziuni de
   `NNNN` — și documentează ordinea reală.
8. **Renumerotează coliziunile de `NNNN`** doar pentru migrările **neaplicate încă**. Cele aplicate
   rămân ca sunt: redenumirea unei migrări aplicate o transformă în una nouă.

**Verificare etapa 5 (obligatoriu pe dump, nu pe producție):**
```bash
pg_restore -d swypik_test dump-prod.sql
bash scripts/db/apply-all-pending.sh          # a doua rulare trebuie să fie NO-OP
bash scripts/db/apply-all-pending.sh          # 0 migrări aplicate, exit 0
bash scripts/db/check-schema-drift.sh         # exit 0, nu 3
pg_dump --schema-only swypik_test | diff - db/schema.sql   # doar diferențe intenționate
```
Și un test unitar (`G6`) care asertează: fiecare fișier din `db/migrations/` are prefix `NNNN` unic
și niciun nume nu apare de două ori sub forme diferite.

---

### Etapa 6 — Manifest unic pentru cron

31 de rute sub `app/api/cron/`; programarea lor stă într-un shell script din alt arbore
(`infra/hetzner/cron-worker/run.sh:21`), cu `run_job` hardcodat. Adăugarea unei rute nu o programează;
ștergerea sau redenumirea unui director produce 404 în worker fără ca vreun test sau build să cadă
(cazul `watchdog-rides`, documentat în `docs/AUDIT-TOTAL-2026-08-05.md`). Autentificarea are două
convenții incompatibile: `daily-maintenance` e neapelabil de worker chiar dacă ar fi în `run.sh` —
ar întoarce 401 pe Bearer. Joburi de integritate financiară (`verify-supply`, `swyp-reconcile`) pot
rămâne neexecutate luni fără semnal.

**Împarte în două PR-uri, ca să ai build verde între ele:**

**6a — registry + test, fără schimbare de comportament.**
```ts
// lib/cron/registry.ts
export const CRON_JOBS = [
  { job: "process-payouts", method: "POST", schedule: "*/30 * * * *" },
  // ... 31 de intrări
] as const;
```
Adaugă testul `G7`: mulțimea directoarelor din `app/api/cron/` == mulțimea `job`-urilor din registry
== mulțimea joburilor din `run.sh`. Testul **va pica** la prima rulare — asta e rezultatul util.
Repară registry-ul până trece. Zero cod de producție atins.

**6b — `defineCronJob` + `_manifest`.**
```ts
// lib/cron/defineCronJob.ts — un singur loc pentru validarea secretului (ambele headere,
// comparație timing-safe) + runCron(name, fn)
export const { GET, POST } = defineCronJob("process-payouts", async () => { /* ... */ });
```
Expune `GET /api/cron/_manifest` care servește registry-ul; `run.sh` îl citește la pornire și
generează lista de joburi în loc de `run_job` hardcodat. Rescrie cele 31 de rute **în tranșe de câte
5**, cu verificarea standard între tranșe.

Atenție separată: planificatorul din `run.sh:67` folosește ferestre `TICK % N < 60` cu un ciclu care
durează peste 60 de secunde, deci sare tăcut peste rulări. Corectează-l în același PR cu 6b, altfel
manifestul corect va programa joburi care tot nu rulează.

**Verificare etapa 6:** testul `G7` verde; `curl -s localhost:3000/api/cron/_manifest | jq length`
→ 31; pe staging, rulează `run.sh` cu un `TICK` forțat și confirmă în loguri că fiecare job e apelat
o dată; `curl -X POST` fără secret pe fiecare rută → 401 uniform, pe ambele convenții de header.

---

### Etapa 7 — Un singur checkout (ultima, cea mai mare)

**Trei implementări paralele, cu modele de securitate diferite:**

1. `app/api/checkout/route.ts` (~350 linii) — **nu** consultă `isUserFraudBlocked`, **nu** are
   idempotență. Un user `fraud_blocked` respins pe fluxul din aplicație intră normal prin
   `/api/v1/checkout`, pe care proxy-ul îl redirecționează aici. Un dublu-click creează două comenzi
   și două sesiuni Stripe.
2. `app/api/checkout/create-intent/route.ts` (~350 linii) — are poarta de fraudă și idempotența.
3. `services/platform-api/internal/checkout/service.go:198` — calculează totalul din **prețul trimis
   de client**: `{"items":[{"product_id":"...","unit_amount_ron":1}]}` produce o comandă de 1 RON.
   E ținut inactiv de un `if` de trei linii în `app/api/v1/[...path]/route.ts:45`. Nu e cod mort —
   e cod armat: o refactorizare care pare cosmetică („proxy-ul tratează deja toate căile”) mută
   instant checkout-ul public pe el.

**Pașii:**

1. **Întâi, garda.** Adaugă în `services/platform-api/internal/checkout/` un test Go care asertează
   că totalul **nu** depinde de `unit_amount_ron` din input. Testul pică azi. Rularea lui în CI
   (`go test ./...` rulează deja în `ci.yml`) face imposibilă activarea accidentală.
2. **Decide proprietarul.** Dacă rămâne Next: șterge `service.go`, `postgres_store.go` și
   înregistrările `POST /v1/checkout` + `POST /v1/cart/items` din `api.go:75-76`, apoi scoate
   short-circuit-ul devenit inutil din `app/api/v1/[...path]/route.ts:44-46`. Dacă serviciul Go
   trebuie păstrat: șterge câmpul `UnitAmountRON` din `AddCartItemInput` (`service.go:26`) și citește
   prețul din `marketplace_products` în `postgres_store.go` înainte de a calcula `total`.
3. **Extrage partea comună** în `lib/checkout/prepare.ts`: validare cantități,
   `getCheckoutProductById`, verificarea de stoc pe `marketplace_product_variants`, calculul
   subtotalului, `resolveCheckoutAttribution`. Mută poarta de fraudă și claim-ul de idempotență din
   `create-intent` în modulul comun, apelat ca **prim pas** de ambele rute.
4. **Redu cele două rute** la strict crearea obiectului Stripe (Session vs PaymentIntent) peste
   rezultatul comun. Dacă fluxul hosted-session nu mai e folosit din UI — verifică:
   `grep -rn "\"/api/checkout\"" app components` — șterge `app/api/checkout/route.ts` complet și
   redirecționează `/api/v1/checkout` către `create-intent`.

**Verificare etapa 7:** teste unitare noi pentru `prepare.ts` (user blocat → refuz pe **ambele** căi;
a doua cerere cu aceeași cheie de idempotență → aceeași comandă, nu una nouă); `go test ./...` verde;
pe staging, o comandă reală prin fiecare din cele două căi, cu verificarea că `commerce_orders`
primește exact un rând.

---

### Etapa 8 — Consolidarea uneltelor și a testelor

**8.1 Patru sisteme de test paralele → două.**
```
tests/unit/       vitest, 126 teste, rulează în ci.yml           ← singurul pentru teste de sursă
tests/e2e/        playwright `mobile`/`desktop`, read-only        ← rulează în e2e.yml pe producție
tests/e2e-full/   playwright `full-desktop`/`full-mobile`         ← NU rulează nicăieri
tools/test-*.mjs  runnere ad-hoc node, apelate din `npm run ci`   ← paralel cu vitest
```
`tests/e2e-full` acoperă signup, roluri și cazuri negative — arată ca o plasă de siguranță în orice
audit, dar nu prinde nimic. Sunt exact invariantele care contează pentru cele 5 rezolvere de sesiune
din etapa 2.

- **Varianta bună:** job `e2e-full` în `ci.yml` cu `services: postgres:16`, migrări aplicate,
  `npm run build && npm run start &`, `PLAYWRIGHT_BASE_URL=http://localhost:3000` (fără
  `ALLOW_PROD_E2E`, deci garda de producție rămâne activă), `npx playwright test --project=full-desktop`.
- **Varianta minimă, dacă infrastructura nu încape acum:** șterge proiectele `full-desktop`/`full-mobile`
  din `playwright.config.ts`, șterge `tests/e2e-full/`, și mută invariantele lor de securitate în
  teste unitare pe tiparul din `tests/unit/gdpr-export.test.ts`.
  **Nu lăsa varianta a treia** — suite prezente care nu rulează.

`tools/test-{platform,workers,dispatch,...}.mjs`: mută-le ca teste vitest în `tests/unit/` sau
șterge-le. `npm run ci` din `package.json` trebuie să apeleze `npm test`, nu runnere proprii.

**8.2 `tools/` → `scripts/audit/`.**
După ce calea hardcodată e reparată (etapa 1.5), mută `tools/audit-*.sh` în `scripts/audit/` și
`tools/check-migration-drift.sh` în `scripts/db/`. `tools/gapscan.mjs` e citat în `TODO.md:3` ca sursă
a unui tabel fals — verifică dacă mai rulează; dacă nu, șterge-l odată cu referința.

**8.3 `chain/` → `infra/chain/`.** Zece scripturi shell/python de setup blockchain la rădăcina
repo-ului, lângă `app/` și `lib/`. Nu se importă de nicăieri; sunt configurație de infrastructură.

**Verificare etapa 8:** `npm run ci` rulează vitest; `rg "tools/" .github/ package.json scripts/ docs/`
→ 0 referințe rămase; job-ul `e2e-full` verde în CI (sau proiectele șterse din config, coerent).

---

### Etapa 9 — Documentația care contrazice codul

Ultimul, pentru că depinde de deciziile luate la 5, 6 și 7.

| Fișier | Problema | Acțiune |
|---|---|---|
| `CLAUDE.md:23` | workflow mort: branch `mvp-freeze` inexistent, alt repo GitHub, VPS nefolosit. Regula 1 („EDIT NUMAI PE VPS”, linia 152) contrazice frontal `DEVIZ.md:11`. | Șterge liniile 19-34, pune un pointer unic la `docs/DEPLOY.md` §0. `main` + `office233/swypik-commerce-platform`. Șterge regula 1. |
| `CLAUDE.md:7,64-70` | descrie `next-themes`, `ThemeProvider`, `ThemeToggle` — niciunul nu există. `FEATURE_GO` nedocumentat. | Descrie mecanismul real (`darkMode: "class"`, `tailwind.config.ts:5`). Generează secțiunea de structură dintr-un script rulat în CI. |
| `DEV.md:53` | trimite `psql -d swypik_prod` și deploy-ul către `178.105.46.66` — host dezafectat care găzduiește alt proiect (Meister ERP). | Mută în `docs/_archive/` cu banner `STALE 2026-07-30`. Guard în CI pe `178.105.46.66` / `46.224.197.2` în `*.md` de la rădăcină. |
| `DEVIZ.md:5` | același IP. | idem. |
| `TODO.md:119-129` | declară 6 API-uri lipsă „confirmate prin scanare” — toate 6 există. Un agent care ia asta ca plan rescrie rute existente și pierde logica de plată. | Șterge tabelul și avertismentele de la liniile 92, 105, 115. Corectează linia 137 (există 126 de teste vitest). |
| `README.md:57` | quick start pornește de la `.env.social.example`, fișier inexistent. Dublat în `docs/LOCAL_DEVELOPMENT.md:22`. | Alege o singură variantă (adaugă fișierul SAU schimbă în `.env.example`) și aplic-o în ambele locuri. |
| `.env.example:189` | `FEATURE_STRIPE_CONNECT=false` — mediul pornit din el are **payout-urile oprite**, iar `/api/cron/process-payouts` răspunde 410 (nu 500, deci schedulerele nu alertează). 8 flaguri nedocumentate. | Blocul complet al celor 9 flaguri din `lib/feature-flags.ts`, cu valoarea de producție și un comentariu despre ce oprește fiecare. Adaugă `FEATURE_STRIPE_CONNECT` în `REQUIRED prodOnly` din `scripts/ops/check-env.mjs`. |
| `.env.example:39` | `FLY_MARKUP_CENTS` — configurație moartă, nu o citește niciun rând de cod. | Șterge; documentează `FLY_MARKUP_PCT=10`, `FLY_MARKUP_FLOOR_RON=1500`, `FLY_MARKUP_MIN_CENTS=1200` cu valori **reale, nu goale** (`??` nu prinde stringul vid, deci podelele devin 0). |
| `docs/AUDIT-*.md` ×8 | rapoarte istorice în calea de citire. | `docs/_archive/`. |

**Verificare etapa 9:** `node scripts/ops/check-env.mjs` pe un `.env` copiat din `.env.example`
iese cu 0 **și** flagurile de producție sunt corecte; grep-ul de IP-uri moarte în CI trece;
`ls *.md` → `README.md CLAUDE.md`.

---

## 3. Convenții

### Reguli de denumire și organizare

**C1 — Rutare.** Orice pagină publică stă sub `app/[locale]/`. Un director direct sub `app/` e
permis **numai** dacă numele lui e în `NON_LOCALIZED_PREFIXES` din `middleware.ts`. Niciun nume nu
are voie să existe simultan sub `app/` și sub `app/[locale]/`.

**C2 — Limba.** Engleză pentru căi de URL, nume de fișiere, nume de coloane și identificatori.
Româna apare **exclusiv** în `messages/*.json` și în comentarii. „Swypik Cares” e brand, nu cale.

**C3 — API.** Segmente `kebab-case`, colecții la **plural** (`/api/creators`, nu `/api/creator`),
parametri de query `snake_case`, un singur nume canonic per parametru — **niciun alias**. Un alias e
o divergență cu permis de ședere.

**C4 — `lib/`.** Un subdirector per domeniu. Rădăcina `lib/` are o **listă închisă**:
`db.ts`, `logger.ts`, `api-handler.ts`, `redis.ts`, `url.ts`, `feature-flags.ts`,
`feature-flags-client.ts`. Nu există niciodată un fișier `X.ts` și un director `X/` cu același nume.

**C5 — Colocare.** O componentă folosită de o singură rută stă lângă acea rută (`*Client.tsx`).
La al doilea consumator se mută în `components/<domeniu>/`. Aceeași regulă pentru tipuri și helpere.

**C6 — Primitivă unică.** Fiecare din următoarele are exact **un** modul proprietar; orice a doua
implementare e un bug, nu o variantă:

| Primitivă | Proprietar |
|---|---|
| citire cookie de sesiune + `user_sessions` | `lib/auth/session.ts` |
| IP client (`getClientIP`) | `lib/security/rate-limit.ts` |
| rate limit | `lib/security/rate-limit.ts` |
| formatare bani | `lib/i18n/currency.ts` |
| conexiune DB (`dbQuery`, `withTransaction`) | `lib/db.ts` |
| rate de comision | `lib/config/commerce.ts` |
| căi statice pentru SEO | `lib/seo/static-paths.ts` |
| programare cron | `lib/cron/registry.ts` |

**C7 — Migrări.** `db/migrations/YYYYMMDD_NNNN_descriere.sql`. `NNNN` unic în cadrul zilei.
Versiunea înregistrată în ledger = numele complet al fișierului, fără extensie. Un fișier aplicat nu
se redenumește și nu se editează niciodată. SQL nu stă în afara `db/`.

**C8 — Teste.** Teste de sursă: vitest, în `tests/unit/`. E2E: playwright, în `tests/e2e*/`.
Niciun runner ad-hoc. Orice suite existentă rulează în CI sau se șterge.

**C9 — Documentație.** Rădăcina are `README.md` (cum pornești) și `CLAUDE.md` (cum lucrezi, cu
pointere). Orice altceva în `docs/`. Un document care descrie o procedură trebuie să conțină comanda
exactă, copiabilă; un document care nu mai e adevărat merge în `docs/_archive/` cu banner
`STALE <dată>` pe prima linie, nu rămâne „ca referință”.

**C10 — Env.** O variabilă documentată în `.env.example` trebuie să fie citită de cod, și invers.
Valorile exemplu sunt valori **reale de producție**, niciodată goale — `??` nu prinde stringul vid,
iar podelele de marjă devin 0.

---

### Garzi automate

Fără garzi, convențiile de mai sus regresează în două luni. Toate cele de mai jos sunt ieftine: rulează
în `npm test`, care e deja în `ci.yml`.

**G1 — ESLint: importuri interzise** (`.eslintrc.json`)

```json
"no-restricted-imports": ["error", { "patterns": [
  { "group": ["@/lib/db/*"],        "message": "lib/db/ nu mai există. Folosește @/lib/queries/*." },
  { "group": ["@/lib/app-url"],     "message": "Fuzionat în @/lib/url." },
  { "group": ["**/lib/rate-limit"], "message": "Rate limit: @/lib/security/rate-limit. Idempotență: @/lib/idempotency." }
]}]
```

**G2 — ESLint: `x-forwarded-for` doar în helperul canonic.**
Regulă `no-restricted-syntax` care eșuează pe orice
`CallExpression[callee.property.name="get"][arguments.0.value=/x-forwarded-for/i]`, cu `overrides`
care o dezactivează doar în `lib/security/rate-limit.ts`. Blochează direct clasa de bug de la §2.3.

**G3 — ESLint: literalul `"swypik_session"` doar în `lib/auth/session.ts`.**
Aceeași formă, pe `Literal[value="swypik_session"]`. Împreună cu G2, cele două reguli fac imposibilă
reapariția copiilor pe care etapa 2 le elimină.

**G4 — `tests/unit/auth-invariants.test.ts`** (comportament, nu structură)
- user cu `status='banned'` → anonim pe **ambele** rezolvere;
- `Authorization: Bearer` dă aceeași identitate ca `swypik_session`;
- un cookie de forma `otp:NNNNNN` nu se potrivește cu niciun rând de sesiune;
- `getClientIP` ignoră primul hop fabricat din `X-Forwarded-For`.

**G5 — `tests/unit/structure.test.ts`** (garda centrală; citește discul, nu importă cod)

```ts
// a) niciun nume duplicat între app/ și app/[locale]/
expect(intersect(ls("app"), ls("app/[locale]"))).toEqual([]);
// b) fiecare director direct sub app/ (care nu e [locale] sau api) e în NON_LOCALIZED_PREFIXES
// c) rădăcina lib/ conține exact lista închisă din C4
expect(lsFiles("lib").sort()).toEqual(LIB_ROOT_ALLOWLIST);
// d) niciun X.ts alături de un director X/ în lib/
// e) rădăcina repo-ului are exact README.md și CLAUDE.md ca .md
// f) niciun literal de IP mort în *.md de la rădăcină
```

Testul eșuează cu un mesaj care **numește fișierul** și trimite la regula din acest document.

**G6 — `tests/unit/migrations.test.ts`**
- fiecare fișier din `db/migrations/` respectă `YYYYMMDD_NNNN_*.sql`;
- niciun `YYYYMMDD_NNNN` duplicat;
- niciun nume care apare și cu, și fără `NNNN` (bug-ul de la §1.4);
- niciun `.sql` în `lib/`.

**G7 — `tests/unit/cron-registry.test.ts`**
Mulțimea directoarelor din `app/api/cron/` == `CRON_JOBS` din `lib/cron/registry.ts` ==
joburile din `infra/hetzner/cron-worker/run.sh`. Trei liste care azi nu se ating niciodată.

**G8 — `tests/unit/seo-paths.test.ts`**
`lib/seo/static-paths.ts` e singura sursă; `app/static-sitemap.xml/route.ts`,
`app/api/cron/indexnow/route.ts` și `app/api/cron/bing-url-submit/route.ts` nu conțin literale de cale.

**G9 — `.githooks/pre-commit`**, extins (rapid, sub 3 secunde):
```sh
node scripts/i18n-guard.mjs || exit 1          # cu calea --fix reparată (§1.6)
npx vitest run tests/unit/structure.test.ts tests/unit/migrations.test.ts || exit 1
```
Hook-ul **nu** rulează `tsc` sau `build` — un hook lent e un hook ocolit cu `--no-verify`.

**G10 — `ci.yml`:** adaugă job-ul `e2e-full` (sau șterge suitele, coerent cu §8.1) și un pas
`node scripts/ops/check-env.mjs` peste un `.env` generat din `.env.example` — validatorul care există
tocmai ca să prindă asta înainte de deploy trebuie să ruleze înainte de deploy.

**G11 — teste pe modulele de bani care azi nu au niciunul** (nu e structură, dar e precondiție
pentru orice refactorizare din etapele 2 și 7):
`tests/unit/webhook-refunds.test.ts` (1084 de linii de handlere Stripe, zero teste),
`tests/unit/wallet-ledger.test.ts` și `tests/unit/swyp-ledger.test.ts` (invariantele de idempotență
și de sold negativ), `tests/unit/payout-cron.test.ts`, `tests/unit/swyp-hybrid.test.ts` (plafonul de
50% implementat în două locuri care au deja divergat). Tiparul există deja în
`tests/unit/moderation.test.ts` și `tests/unit/order-dispatch.test.ts`: `vi.mock("@/lib/db")` + un
`q` mock pentru `withTransaction`.

---

## 4. Ce NU merită atins acum

Fiecare intrare are un cost măsurat și un câștig evaluat. Toate se rezolvă prin **o regulă pentru
viitor**, nu printr-o mutare în prezent.

| Ce | Cost | De ce nu acum |
|---|---|---|
| **Redenumirea `lib/db.ts` → `lib/db/client.ts`** | codemod pe **412** fișiere | Coliziunea se rezolvă complet golind directorul `lib/db/` (11 importatori, §3.1). Un diff de 412 fișiere face imposibil review-ul oricărei alte modificări din aceeași săptămână, pentru exact același rezultat. |
| **Mutarea `lib/logger.ts` (260) și `lib/api-handler.ts` (102)** | 362 de fișiere | Lista închisă din C4 + testul G5 împiedică adăugarea de fișiere noi la rădăcină. Poziția actuală a acestor două nu produce niciun bug cunoscut. |
| **Redenumirea în masă singular→plural în `app/api`** | 315 rute, plus clienți mobili și externi | Renumele de rută nu e verificat de `tsc`; orice `fetch` scris ca string se rupe tăcut. Regula C3 se aplică rutelor noi; consolidezi doar cele 3 endpoint-uri de `apply`, cu shim (§4.4). |
| **`saves` → `video_saves` în DB** | migrare pe producție + 10 fișiere | Bug-ul real e că exportul GDPR omite `saved_products`, `wallet_balances` și `wallet_ledger_entries`. **Repară exportul** în `lib/legal/data-export.ts` — asta e obligația legală. Redenumirea tabelei e cosmetică și e o operație de indisponibilitate pe o tabelă fierbinte. |
| **Monorepo real (pnpm/turbo workspaces) pentru `services/`, `workers/`, `packages/`** | rescrierea CI, a Dockerfile-urilor și a deploy-ului | Cele trei se construiesc și se testează deja independent și corect în `ci.yml` (`go vet`/`go test`, `pytest` matriceal). Un workspace ar adăuga un strat de build fără să rezolve nicio problemă din cele 342 de constatări. |
| **Rescrierea serviciului Go sau mutarea checkout-ului pe el** | luni | Etapa 7 cere **o decizie** (cine deține checkout-ul) și **un test** care blochează calculul din prețul clientului. Ambele se fac într-o zi. |
| **Reorganizarea `components/` într-o ierarhie strictă** | ~120 de fișiere | Tiparul actual (colocare `*Client.tsx` + `components/<domeniu>/`) e deja corect în majoritatea cazurilor. Cele 8 fișiere libere din `components/` (`BottomNav`, `TopBar`, `Logo`, `ChatInterface`, `ProductFeed`, `ProductDrawer`, `CheckoutForm`, `CookieBanner`, `PurchaseTracker`, `VerifiedBadge`) sunt toate globale — locul lor e corect. |
| **`app/[locale]` → route groups per verticală** | toate paginile | Nu schimbă niciun URL și nu previne niciun bug din listă. Zero câștig. |
| **Migrarea celor 171 de migrări pe Prisma / Drizzle / Atlas** | luni + risc pe producție | Problema nu e unealta, e că există **două** runnere și **două** ledgere (§5). Un ledger unic cu `apply-migration.sh` rezolvă totul. |
| **Cele 637 de warning-uri de lint → 0** | difuz, mare | Sunt warning-uri, nu erori; niciunul din cele 52 de critice nu vine de acolo. **Ce merită:** extinde `overrides`-ul existent din `.eslintrc.json` (care deja ridică `no-explicit-any` la `error` pe `webhooks/`, `checkout/`, `lib/swyp/`, `lib/security/`) la `lib/wallet/` și `lib/payments/`. Restul: `--max-warnings 637` în CI, ca pragul să scadă, nu să crească. |
| **Ștergerea `docs/AUDIT-*.md` ×8** | mică | Mută-le în `docs/_archive/`, nu le șterge. `AUDIT-TOTAL-2026-08-05.md` e singura sursă scrisă pentru incidentul `watchdog-rides` care motivează etapa 6. |
| **Curățarea `scripts/_archive/`** | zero | E deja arhivat, deja în afara căii de citire, nu e importat de nimic. Costul de a-l lăsa este zero. |

---

## Ordinea recomandată și efortul estimat

| # | Etapă | Efort | Risc | Blochează |
|---|---|---|---|---|
| 0 | Îngheață baza | 1h | — | tot |
| 1 | Ștergeri pure | 0,5 zile | foarte mic | 3, 5 |
| 2 | Primitive unice (sesiune, IP, bani) | 2–3 zile | **mediu** (atinge auth) | 4, 7 |
| 3 | `lib/`: coliziuni și fișiere libere | 1 zi | mic (`tsc` prinde tot) | — |
| 4 | Nume publice unice + redirecturi | 2 zile | mediu (URL-uri, SEO) | — |
| 5 | Un runner de migrări | 2–3 zile | **mare** (producție) | — |
| 6 | Manifest cron | 2 zile | mediu | — |
| 7 | Un singur checkout | 3–5 zile | **mare** (bani) | — |
| 8 | Unelte și teste | 1–2 zile | mic | — |
| 9 | Documentație | 1 zi | zero | — |

**Etapele 1, 3, 8 și 9 pot începe azi**, în paralel, fără coordonare — nu ating comportament de
runtime. **Etapa 2 e cea mai valoroasă** (închide gaura de ban și diferența de identitate între
rezolvere) și **trebuie făcută înaintea lui 4 și 7**. **Etapa 5 nu se începe** fără un dump de
producție restaurat local și fără tabelul de inventar al celor două ledgere.

Garzile din §3 (G1–G3, G5–G8) se pot adăuga **înaintea** etapelor pe care le protejează: un test
care pică e documentația exactă a ce e de reparat, și e mai ieftin decât orice raport.
