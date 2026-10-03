# Cache la edge (Cloudflare) pentru API-urile publice

Țintă (w6-performance, 2026-09-27): răspunsurile **publice, nepersonalizate** ale API-ului se servesc
din PoP-ul Cloudflare cel mai apropiat de vizitator; replicile web văd doar revalidările. Tot ce e
per-utilizator sau realtime rămâne `private, no-store`.

Sursa unică de adevăr: [`lib/http/cache-policy.ts`](../../../../swypik/commerce/lib/http/cache-policy.ts) — profilurile de TTL,
lista `PUBLIC_ROUTES`, cookie-urile de identitate. Garda: `tests/unit/cache-policy.test.ts` +
`tests/unit/cache-policy-routes.test.ts` (pică dacă o rută publică setează cookie-uri, nu trece prin
helper, sau dacă cineva scrie `public, s-maxage` de mână în altă rută).

## Cum funcționează

1. **Implicit: `private, no-store`.** `middleware.ts` pune antetul pe orice `GET/HEAD /api/*` care nu e
   în `PUBLIC_ROUTES` / `NEXT_MANAGED_ROUTES` (`managesOwnCacheHeaders`). Atenție: un antet pus în
   middleware **câștigă** în fața celui din handler (verificat pe `next start`), de aceea rutele publice
   sunt excluse explicit — nu e suficient ca handler-ul să-și pună propriul antet.
2. **Rutele publice** apelează `applyCachePolicy(response, "<rută>", req)`:
   - `200` fără `Set-Cookie` → `Cache-Control: public, max-age=<b>, s-maxage=<N>, stale-while-revalidate=<M>`;
   - orice altceva (4xx, 429, 5xx, răspuns cu cookie) → `private, no-store` — erorile nu ajung în cache;
   - șterge `CDN-Cache-Control` (un singur antet de adevăr) și `Vary: Cookie` (Cloudflare îl ignoră).
3. **Audiența `anonymous`** (ex. `/api/music/home`, `/api/v1/feed`): public doar dacă cererea nu are
   niciun cookie de identitate; cu sesiune → `private, no-store` (rânduri „Îmi plac”, „Continuă”, seen-set).
   **Cloudflare cache-uiește după URL, nu după cookie** — de aceea regula de mai jos ocolește cache-ul
   când cererea poartă un cookie de identitate; altfel un utilizator logat ar primi copia anonimă.
4. **Limba și moneda vin din URL, nu din cookie.** `/api/products` și `/api/products/[id]` sunt publice
   doar cu `?locale=…&currency=…` (`hasUrlPreferences`); fără ele citesc cookie-urile `swypik_locale` /
   `swypik_currency` și răspund `no-store`.

## Profiluri (TTL)

| Profil | s-maxage | stale-while-revalidate | max-age (browser) | Pentru |
|---|---|---|---|---|
| `static` | 1 h | 24 h | 5 min | taxonomii, orașe, jocuri |
| `external` | 15 min | 1 h | 1 min | cataloage externe preîncălzite (radio, Audius, Jamendo, podcasturi) |
| `catalog` | 5 min | 30 min | 30 s | shop, muzică, filme, produse, clipuri de produs |
| `detail` | 10 min | 1 h | 1 min | detaliu produs, subtitrări |
| `list` | 60 s | 10 min | 15 s | știri, misiuni, postări, feed anonim |
| `search` | 2 min | 10 min | 30 s | căutare, autocomplete |
| `live` | 15 s | 60 s | 0 | liste de stream-uri live |
| `geo` | 24 h | 7 zile | 1 h | proxy Nominatim (politica lor cere cache) |

## Regula Cloudflare (o singură dată, din dashboard)

Zona `swypik.com` → **Caching → Cache Rules → Create rule** — *„API public: respectă TTL-ul originii”*.

**When incoming requests match** → *Edit expression*:

```
(http.request.method in {"GET" "HEAD"}
 and starts_with(http.request.uri.path, "/api/")
 and not starts_with(http.request.uri.path, "/api/admin/")
 and not starts_with(http.request.uri.path, "/api/cron/")
 and not starts_with(http.request.uri.path, "/api/internal/")
 and not starts_with(http.request.uri.path, "/api/partner/")
 and not starts_with(http.request.uri.path, "/api/webhooks/")
 and not http.cookie contains "swypik_session="
 and not http.cookie contains "creator_session="
 and not http.cookie contains "seller_session="
 and not http.cookie contains "admin_session="
 and not http.cookie contains "admin_token="
 and not http.cookie contains "anon_session="
 and not http.cookie contains "swypik_anon="
 and not http.cookie contains "feed_sid=")
```

**Then**:

- Cache eligibility: **Eligible for cache**
- Edge TTL: **Use cache-control header if present, bypass cache if not** — rutele fără `s-maxage`
  (tot ce e `private, no-store`) nu se cache-uiesc niciodată.
- Browser TTL: **Respect origin TTL**
- Cache key: implicit (**include query string** întreg — NU activați „Ignore query string”: `locale`,
  `currency`, `offset`, `q` fac parte din identitatea răspunsului). Fără cookie/antete în cheie.
- Serve stale content while revalidating: **On** (Cloudflare respectă `stale-while-revalidate`).
- Origin Cache Control: **On** (implicit).

Lista de cookie-uri trebuie să rămână identică cu `IDENTITY_COOKIES` din `lib/http/cache-policy.ts`
(testul `cache-policy-routes.test.ts` verifică documentul). Un cookie de identitate nou = o linie nouă aici
și o actualizare a regulii în dashboard.

Plus, recomandat: **Caching → Tiered Cache → Smart Tiered Caching: On** (o revalidare per regiune, nu per PoP)
și **Speed → Optimization → Content Optimization → Brotli: On** (compresia e lăsată la Cloudflare;
`next.config.mjs` are `compress: false`, `NEXT_COMPRESS=1` o repornește pentru un deploy fără Cloudflare).

### Pagini (opțional, a doua regulă)

Paginile ISR (`/`, `/<limbă>`, `/discover`, `/<limbă>/discover`) primesc de la Next
`s-maxage=<revalidate>, stale-while-revalidate`; paginile dinamice (produs, cont, checkout) primesc
`private, no-cache, no-store`. O a doua regulă cu **aceleași** excluderi de cookie și aceeași setare
„Use cache-control header if present, bypass cache if not” le poate servi de la edge:

```
(http.request.method in {"GET" "HEAD"}
 and (http.request.uri.path in {"/" "/discover"}
      or http.request.uri.path matches "^/(en|es|fr|de|pt|it)(/discover)?/?$")
 and not http.cookie contains "swypik_session="
 and not http.cookie contains "creator_session="
 and not http.cookie contains "seller_session="
 and not http.cookie contains "admin_session="
 and not http.cookie contains "admin_token=")
```

(`matches` cere planul Business+; pe Free/Pro enumerați căile cu `in {…}`.) Un răspuns cu `Set-Cookie`
(ex. prima vizită, când next-intl setează `swypik_locale`) nu se cache-uiește — comportamentul implicit
Cloudflare.

## Verificare după activare

```bash
# public: a doua cerere = HIT, antetul vine din cache-policy
curl -sI "https://swypik.com/api/news" | grep -iE "cache-control|cf-cache-status|set-cookie"
curl -sI "https://swypik.com/api/news" | grep -i cf-cache-status        # HIT
# per-utilizator: niciodată în cache
curl -sI "https://swypik.com/api/auth/me" | grep -iE "cache-control|cf-cache-status"   # private, no-store / DYNAMIC
# audiență anonimă: cu sesiune → BYPASS + private
curl -sI -H "Cookie: swypik_session=x" "https://swypik.com/api/music/home" | grep -iE "cache-control|cf-cache-status"
```

`tests/load/k6/edge-cache.js` măsoară raportul de HIT-uri (vezi `docs/infra/load-testing.md`).

## Clasificarea rutelor GET

**Publice** (`PUBLIC_ROUTES`, audiență `public` — ieșire identică pentru toți):
`audio/feed` (external), `audio/search` (search), `audio/tracks` (catalog), `categories` (static),
`founding-slots` (list), `fly/deals` (catalog), `gaming/games` (static),
`geo/search`, `geo/reverse` (geo), `live/streams` (live), `missions` (list), `news` (list; `?slug=` =
articol), `posts`, `posts/[slug]` (list), `products` și `products/[id]` (doar cu `locale`+`currency` în
URL), `products/[id]/videos`, `products/similar`, `shop/products`, `trips/packages`, `videos/[id]/products`
(catalog), `search/suggest` (search), `stays/cities` (static), `videos/[id]/captions`,
`videos/[id]/captions/list` (detail). `fx` = ISR Next (`revalidate = 300`), antet pus de Next.

**Publice doar pentru anonimi** (audiență `anonymous`): `v1/feed`, `feed/universal` (exclude creatorii blocați de viewer), `music/home`, `movies/home`,
`stays/search` (un gazdă logat își exclude propriile anunțuri).

**Per-utilizator — `private, no-store`** (implicit din middleware, unele și explicit): tot `admin/*`,
`seller/*`, `creator/*`, `courier/*`, `me/*`, `users/me/*`, `auth/*`, `cart`, `orders*`, `collections*`,
`notifications`, `dm/*`, `messenger/*`, `wallet`, `rides/*`, `local-orders*`, `merchants/mine`,
`host/*`, `stays/mine`, `stays/bookings*`, `explore/feed` (seen-set per sesiune `feed_sid`),
`feed/offers*`, `gaming/profile`, `gaming/trivia`, `missions/active`, `movies`, `movies/[slug]`,
`movies/[slug]/episodes/*/play`, `music/*` în afară de `music/home` (drepturi de acces, like-uri),
`products/[id]/reviews` (eligibilitate), `products/[id]/save`, `users/profile/*` (starea „urmăresc”),
`videos/[id]/comments` (câmpul `viewer`), `geo` (țara din IP-ul cererii), `health*`, `ready`.

**Realtime / SSE — `no-store`**: `dm/stream/[id]`, `dispatch/[jobId]/stream`, `rides/[id]/stream`,
`live/streams/[id]/chat`, plus `live/streams/[id]/poll|ice`.

**Media semnată**: `movies/stream/*`, `music/stream/*` — proxy de dezvoltare, în producție 404
(media trece prin Worker-ul de pe `media.swypik.com`, vezi `docs/infra/r2.md`).

Candidați pentru mai târziu (acum per-utilizator doar din cauza unui câmp de viewer): `movies`,
`movies/[slug]`, `music/tracks*`, `users/profile/[username]`, `videos/[id]/comments` — separarea
câmpului de viewer într-un apel mic, privat, le-ar face publice.

## Invalidare

TTL-urile sunt scurte, deci nu există purge automat. Excepții:
- **Știri retrase**: lista caldă din Redis e ștearsă la moderare (`lib/prewarm/news.ts`); edge-ul le mai
  poate arăta cel mult `s-maxage` (60 s) + fereastra `stale-while-revalidate`. Pentru o retragere
  urgentă: *Caching → Configuration → Custom Purge → URL* cu `https://swypik.com/api/news`,
  `…/api/news?category=<slug>` pentru fiecare categorie și `…/api/news?slug=<articol>` (purge pe prefix
  e doar pe Enterprise).
- Un deploy nu cere purge: răspunsurile API nu depind de build.
