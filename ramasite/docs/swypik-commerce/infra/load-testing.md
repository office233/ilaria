# Swypik — teste de încărcare (k6)

Principiu: **măsurăm pe staging, niciodată pe producție.** Scripturile sunt în
`tests/load/k6/`, câte unul pe scenariu, cu configurația comună în
`tests/load/k6/lib/` (`config.js` — ținta, profilurile, pragurile; `http.js` —
cereri etichetate, check-uri, metrici custom; `discover.js` — id-uri reale).
Complementul „static” e bugetul de bundle (`npm run perf:budget`, la final).

## 1. Instalare k6

k6 e un binar separat (nu e dependență npm, nu intră în `node_modules`):

| Sistem | Comandă |
|--------|---------|
| Windows | `winget install k6 --source winget` (sau `choco install k6`) |
| Ubuntu / WSL | pachetul oficial `k6` din repo-ul `dl.k6.io` (vezi grafana.com/docs/k6 → Installation) |
| macOS | `brew install k6` |
| Docker | `docker run --rm -i grafana/k6 run - <script.js` (atenție: importurile `./lib/*` cer montarea directorului) |

Verificare: `k6 version`. Scripturile folosesc doar modulele de bază (`k6`,
`k6/http`, `k6/metrics`), fără extensii.

## 2. Reguli (obligatorii)

- **Niciodată producție.** `lib/config.js` refuză să pornească dacă `BASE_URL`
  lipsește sau are host-ul `swypik.com` / `www.swypik.com` — nu există flag de
  ocolire și nu trebuie adăugat. Toată infrastructura rulează azi pe un singur PC
  (distro-ul WSL `swypik`): un test de stres pe producție = site-ul căzut.
- **Coordonează cu owner-ul** înainte de orice rulaj `load`/`stress`: ora, durata,
  ținta. Staging-ul poate împărți mașina / baza de date cu alte servicii.
- **Scrierile sunt opt-in**: `social-writes.js` trimite like-uri/comentarii doar
  cu `-e ALLOW_WRITES=1` și cu cookie-ul unui **cont de test** (`SESSION_COOKIE`).
  Comentariile trec prin moderarea Azure Content Safety → cost real per cerere;
  păstrează `COMMENT_RATIO` mic. Scenariul își șterge comentariile și lasă
  like-urile în starea inițială (PUT urmat de DELETE).
- Nu pune `SESSION_COOKIE` în fișiere commise sau în istoric de shell partajat;
  folosește o variabilă de mediu locală și invalidează sesiunea după test.

### Rate limiting (429)

Limitele aplicației (`lib/security/rate-limit.ts`) sunt per IP client (din
`X-Real-IP` / ultimul hop `X-Forwarded-For` pus de ingress), ex.
`musicCatalog` = 60/min, `exploreFeed` = 120/min. Un singur generator k6 = un
singur IP, deci la `load`/`stress` **vei primi 429** — e comportamentul corect
al aplicației, nu o regresie. Aplicația **nu are allowlist de IP-uri** (intenționat:
orice bypass ar fi exploatabil). Variante:

1. **Acceptă 429 ca rezultat așteptat:** `-e TOLERATE_429=1`. Atunci 429 nu mai
   intră în `http_req_failed` (și nici în check-uri), ci în metrica
   `rate_limited`, cu pragul `rate<0.20` (peste 20% din cereri limitate =
   testul nu mai măsoară nimic util → pică).
2. **Distribuie generatorul pe mai multe IP-uri** (mai multe mașini / runneri
   cloud), fiecare cu un `MAX_VUS` mai mic.
3. **Cloudflare:** dacă ținta trece prin Cloudflare și există reguli WAF de rate
   limiting, adaugă o regulă de tip *Skip* pentru IP-ul generatorului **doar pe
   zona/host-ul de staging**, pe durata testului, apoi șterge-o. Asta nu
   ocolește limitele din aplicație (vezi 1 și 2).

Fără `TOLERATE_429`, orice 429 contează ca eroare → la `smoke` (1–2 VU) nu ar
trebui să apară; dacă apare, limita e prea strânsă pentru un utilizator real.

## 3. Scenarii

| Fișier | Ce lovește | Latență (p95 / p99) |
|--------|-----------|---------------------|
| `home-feed.js` | `GET /api/v1/feed?limit=15&offset=0` anonim (cache-abil la edge) | 800 / 1500 ms |
| `feed-pagination.js` | feed-ul urmând `paging.nextOffset` pe `FEED_PAGES` pagini (implicit 5), `seed` aleator → origine | 800 / 1500 prima, 1000 / 2000 următoarele |
| `product-page.js` | `GET /api/products/<id>` + pagina SSR `/<LOCALE>/product/<id>` | 600 / 1200 API, 1500 / 3000 HTML |
| `music-home.js` | `GET /api/music/home` + `GET /api/audio/feed?tab=radio` | 700 / 1500, 1200 / 2500 |
| `news.js` | `GET /api/news?limit=20` (+ uneori pagina 2) | 600 / 1200 |
| `social-writes.js` | GET like + listă comentarii; cu `ALLOW_WRITES=1`: PUT/DELETE like, POST/DELETE comentariu | 400–1500 / 900–3000 |
| `live-chat-sse.js` | lista JSON a chatului + conexiune SSE `/api/live/streams/<id>/chat` | 500 / 1000 (lista) |
| `edge-cache.js` | feed + radio + `/api/products` anonime, raport `cf-cache-status: HIT` | 300 / 800 |

Id-uri: `PRODUCT_IDS`, `VIDEO_IDS`, `STREAM_IDS` (CSV) sau descoperite automat în
`setup()` din `/api/products`, `/api/v1/feed`, `/api/live/streams?status=live`.
Pentru `live-chat-sse.js` trebuie să existe un stream **live** pe staging.

Modulele cu flag (Music, News) trebuie să fie pornite pe staging (`FEATURE_MUSIC`,
`FEATURE_NEWS` + perechile `NEXT_PUBLIC_*` la build), altfel rutele răspund 404.

## 4. Rulare

```bash
# smoke — verifică doar că totul răspunde (1–2 VU, ~1,5 min)
k6 run -e BASE_URL=https://staging.example -e PROFILE=smoke tests/load/k6/music-home.js

# load — trafic normal estimat (vârf 50 VU, ~10 min)
k6 run -e BASE_URL=https://staging.example -e PROFILE=load -e TOLERATE_429=1 tests/load/k6/home-feed.js

# stress — peste capacitate (vârf 200 VU, ~13 min); MAX_VUS suprascrie vârful
k6 run -e BASE_URL=https://staging.example -e PROFILE=stress -e MAX_VUS=120 -e TOLERATE_429=1 tests/load/k6/feed-pagination.js

# scrieri cu contul de test
k6 run -e BASE_URL=https://staging.example -e PROFILE=smoke -e ALLOW_WRITES=1 \
       -e SESSION_COOKIE="$SWYPIK_TEST_SESSION" tests/load/k6/social-writes.js

# cache edge (doar în spatele Cloudflare)
k6 run -e BASE_URL=https://staging.example -e PROFILE=smoke -e EXPECT_CF=1 tests/load/k6/edge-cache.js
```

Profiluri (`PROFILE`, rampă liniară între trepte):

| Profil | Vârf VU | Trepte |
|--------|---------|--------|
| `smoke` | 2 | 30s→1, 1m la 1, 10s→0 |
| `load` | 50 | 2m→50%, 5m→100%, 2m la 100%, 1m→0 |
| `stress` | 200 | 2m→25%, 3m→50%, 3m→100%, 3m la 100%, 2m→0 |

Alte variabile: `LOCALE` (implicit `ro`), `FEED_PAGES`, `FEED_LIMIT`,
`COMMENT_RATIO` (implicit 0.1), `SSE_HOLD` (implicit `5s`).
Rezultate brute pentru comparații: `k6 run --summary-export=rezultat.json ...`
sau `--out json=rulaj.json`.

## 5. Ce înseamnă pragurile

Un prag depășit → k6 iese cu cod ≠ 0 și marchează linia cu ✗ în sumar.

- `http_req_failed rate<0.01` — sub 1% din cereri pot eșua (status ≥ 400 sau
  eroare de rețea; 429 doar fără `TOLERATE_429`).
- `http_req_duration{name:X} p(95)<… p(99)<…` — latența per endpoint (tag-ul
  `name` din scripturi), nu media globală: un endpoint lent nu se ascunde în
  spatele celor rapide. p95 = experiența „obișnuită”, p99 = coada lungă.
- `checks rate>0.99` — corpul răspunsului are forma așteptată (ex. `items` e
  listă, `paging.nextOffset` există). Un 200 cu corp greșit pică aici.
- `rate_limited rate<0.20` — activ doar cu `TOLERATE_429=1`.
- `edge_cache_hit rate>0.80` — activ doar cu `EXPECT_CF=1`. Se înregistrează
  numai răspunsurile care au header `cf-cache-status`; `edge_no_cf_header`
  numără răspunsurile fără el (ținta nu e în spatele Cloudflare sau lipsește
  regula de cache pentru `/api/*` — JSON-ul nu e cache-uit implicit). Cererile
  sunt anonime: cu cookie feed-ul e `private` și **nu trebuie** să fie HIT.
- `sse_connect_ok rate>0.99` (`live-chat-sse.js`) — vezi mai jos.
- `feed_pages_reached` (Trend, fără prag) — câte pagini a parcurs o iterație;
  valori mici = feed prea scurt pe staging sau pagini eșuate.

### SSE și limitele k6

k6 nu are `EventSource` și nu citește corpuri în streaming. O conexiune SSE
sănătoasă nu se termină, deci cererea expiră după `SSE_HOLD` cu `error_code`
1050 — scriptul tratează asta ca „acceptată și ținută deschisă”. Un răspuns
imediat 400/404/429/5xx e eșec (`sse_rejected`). Dacă serverul închide singur
stream-ul, se verifică `Content-Type: text/event-stream` și primul cadru
(`retry:`). Timeout-urile intenționate apar ca avertismente „request timeout” în
consolă și în `http_req_failed` global — de aceea în acest scenariu pragul de
erori se aplică doar listei JSON. Pentru fan-out real (mii de conexiuni care
primesc mesaje) folosește extensia `xk6-sse` (build k6 custom cu `xk6`).

## 6. Cum citești rezultatele

1. Sumarul final: fiecare prag cu ✓/✗; apoi `http_req_duration` defalcat pe
   `name` (avg / med / p90 / p95 / p99 / max).
2. `http_req_failed` > 0 → caută în consolă statusurile; 5xx = problemă de
   aplicație/DB (vezi logurile `web-next`), 429 = rate limit (secțiunea 2),
   status 0 = timeout/conexiune (tunel, pool Postgres epuizat).
3. Compară `load` cu `smoke`: dacă p95 crește mult peste 2× la 50 VU, gâtul e de
   obicei Postgres (`max_connections`, interogări fără index) — vezi
   `docs/infra/scaling.md` §3.
4. La `stress`, notează VU-ul la care `http_req_failed` sau p99 explodează:
   aceea e capacitatea curentă a nodului; o trecem în `scaling.md`.
5. Păstrează `--summary-export` pentru fiecare rulaj (dată + commit + profil),
   ca să vezi regresii între release-uri.

## 7. Bugetul de bundle (First-Load JS)

`npm run perf:budget` (rulează în `npm run ci` imediat după `npm run build`)
calculează First-Load JS gzip per rută din `.next/app-build-manifest.json` +
`.next/build-manifest.json` și îl compară cu `scripts/perf/bundle-baseline.json`.

- Pică (exit 1) dacă o rută crește peste `max(+5%, +5 KB)` sau o rută nouă
  depășește 350 KB gzip. Configurabil: `--tolerance-pct`, `--tolerance-kb`,
  `--cap-kb` (sau `PERF_BUDGET_TOLERANCE_PCT`, `PERF_BUDGET_TOLERANCE_KB`,
  `PERF_BUDGET_CAP_KB`); `--dir` / `NEXT_DIST_DIR` pentru alt director de build;
  `--json` pentru ieșire mașină.
- Creștere asumată: `npm run perf:budget -- --update` și commit la baseline.
- Fără baseline, scriptul afișează un mesaj și iese cu 0 (primul rulaj).
