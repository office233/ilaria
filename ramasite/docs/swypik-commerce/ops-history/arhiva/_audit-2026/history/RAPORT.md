# RAPORT Audit & Reparații Swypik — 2026-08-24

Auditor: Claude Code. Branch: `fix/audit-swypik` (swypik/app). Continuarea [AUDIT.md](AUDIT.md).
Misiune: analiză end-to-end + reparare — algoritm feed, like-uri, cod spaghetti, design.

## Verificare finală
| Check | Rezultat |
|---|---|
| `tsc --noEmit` | ✅ curat |
| `vitest run` | ✅ 122/122 (116 existente + 6 noi, regresie pe bug-ul de like) |
| `eslint` (fișiere modificate) | ✅ 0 erori (doar warnings `any` preexistente) |
| `next build` | ✅ exit 0 |

**Validat pe baza reală din WSL (2026-08-25)**: migrările sunt aplicate și verificate, iar codul nou a fost rulat contra bazei tale — vezi [DEPLOY.md](DEPLOY.md) pentru tabelul complet de verificări. Scorul maxim de ranking a urcat 2.00 → 20.00 după migrare, dovadă că semnalul de re-watch (care număra un tip de eveniment inexistent) contează acum.

**Rămâne de făcut**: containerul `web-next` din WSL rulează încă **codul vechi** — trebuie reconstruit ca fix-urile de cod să devină active. Comanda e în DEPLOY.md (nu am acces la `docker`/`wsl -e` din sesiunea mea).

---

## 1. LIKE-URI — de ce „nu funcționau" și ce s-a reparat

Arhitectura reală: o singură tabelă polimorfă `likes` (video XOR comment XOR product) + contoare denormalizate. Problemele erau de **cablare**, nu de schemă.

### Reparate
1. **Feed-ul de pe homepage (tab „feed" → ProductFeed): like-urile nu se salvau NICIODATĂ.** `/api/v1/feed` (bridge spre explore/feed) nu punea `video_id` pe obiectul produs; clientul trimitea POST către UUID-ul produsului → 404 → revert silențios pe gri. Fix: `withVideoRefs()` în `app/api/v1/feed/route.ts` + propagare `video_id` în `lib/chat/feed-normalize.ts` + `types/product.ts`. Butonul de like se randează acum doar când există o țintă persistabilă (UUID valid) — fără inimi false.
2. **Race condition la unlike** (`app/api/videos/[id]/like/route.ts`): două unlike-uri concurente dublu-decrementau `like_count`. Fix: `DELETE ... RETURNING` + decrement doar dacă rândul chiar s-a șters.
3. **Evenimentul de ranking era mort**: like-ul scria `'video_liked'` (tip legacy pe care niciun ranking nu-l numără); algoritmul numără `'like'`. Fix: serverul scrie `'like'` la like și `'unlike'` la retragere, doar pentru sesiuni autentificate complet (anti-frauda păstrată). Emisia duplicată din client (ExploreClient + ProductFeed) a fost scoasă — o singură sursă de adevăr.
4. **Politică de auth — analizată, păstrată deliberat.** Like-ul pe video cere login (401 → redirect), like-ul pe produs/comentariu merge anonim. Am încercat întâi alinierea (anon peste tot), apoi am revenit: un like anonim rămâne legat de user-ul anon și **dispare la autentificare**, iar contorul devine inflatabil prin rotirea cookie-ului. TikTok/Instagram cer și ele login pentru like. Comportamentul rămâne cel existent, acum documentat în cod. Rămâne de decis (întrebare pentru tine): vrei ca like-urile anonime pe **produse** să migreze la contul real după login? Azi se pierd.
   Ca efect secundar al analizei, like-ul pe produs — care chiar e anonim — a primit limită pe IP (`productLike`, 40/min), apărarea pe care proiectul o avea deja la comentarii împotriva rotirii de cookie.
5. **Comentarii: inima pornea mereu gri** — GET-ul de comentarii nu întorcea starea viewerului, deci al doilea tap făcea de fapt unlike. Fix: `viewer_liked` per comentariu (o singură interogare suplimentară) + seed în `CommentsSheet`.
6. **Notificările de like/comment duceau pe pagină inexistentă**: `/v/{videoId}` e pagina de VERTICALE (404 pe UUID). Fix: `/explore?v={videoId}` în like route, comments route și `lib/notifications/dispatch.ts`.
7. **Validare lipsă**: comment-like fără UUID check → 500 în loc de 400. Fix adăugat.
8. **Rate-limit bucket partajat**: like-ul și share-ul de produs consumau bucketul `videoLike` al aceluiași user. Fix: buckets separate `productLike`, `productShare`.
9. **Contract de răspuns**: produsele întorceau `{likeCount}`, video `{like_count}`. Ambele rute întorc acum ambele chei.
10. **Pagina `/account/liked` era orfană** — legată acum ca tab „Apreciate" în profil.

### Ce funcționa deja corect
ExploreClient (logat) și OfferCard/OffersFeed pe homepage — optimistic update + reconciliere din server, hidratare corectă post-SSR.

---

## 2. ALGORITMUL DE FEED — diagnostic și reparații

`/api/explore/feed` avea deja un schelet serios (engagement 14 zile din `feed_events` prin mat view `video_rank_14d`, freshness, pgvector taste, interese, echitate creatori mici, penalizare repetare, A/B pe ponderi). **Dar personalizarea era în mare parte inertă:**

### Reparate
1. **Semnalele cu cea mai mare pondere nu se emiteau niciodată**: player-ul principal nu trimitea `completion`, `skip_fast`, `rewatch` (clipurile au `loop`, deci `ended` nu se declanșează). Fix în `ExploreClient`: detecție wrap-de-buclă (completion la bucla 1, rewatch la 2+, cu resetarea acumulatorului de watch-time per buclă) + `skip_fast` la swipe sub 2s.
2. **Bug de tip eveniment în mat view**: `video_rank_14d` număra `event_type = 'view'` — tip inexistent (clientul emite `video_view`; `'view'` nici nu trece de CHECK) → semnalul re-watch era 0 pe veci. Fix în migrarea nouă `db/migrations/20260824_0001_video_rank_fix_events.sql`.
3. **Unlike nu se scădea niciodată** din ranking — un like retras rămânea numărat. Fix în aceeași migrare: `GREATEST(likeri − unlikeri, 0)`.
4. **Anti-frauda fusese pierdută la rescrierea MV-ului** (20260811): expresia inline număra doar actori autentificați deduplicat, dar MV-ul — singurul folosit — număra `count(*)` pe telemetrie anonimă injectabilă. Restaurat în migrarea nouă.
5. **Jitterul îneca personalizarea**: `random()*15` vs. interese ≤10, freshness ≤5. Redus la 6 și făcut tunabil live (`feed_weights.w_explore`), fără redeploy.
6. **Bucla de învățare nu pornea niciodată din UI**: `/api/feed/action` (not_interested → user_interests + user_hidden_videos) avea zero apelanți. Fix: buton „Nu mă interesează" (EyeOff) în rail-ul de acțiuni din explore, cu ascundere locală imediată.
7. **Feed-ul universal („inima Swypik", paginile de verticale) era pur cronologic** — zero algoritm; ponderile orare afectau doar bara de categorii. Fix: `ORDER BY` cu rank comprimat din `video_rank_14d` + freshness + explorare mică — aceeași filozofie ca explore/feed.
7b. **…și, de fapt, era complet mort.** Descoperit la validarea pe baza reală (2026-08-25): interogarea făcea `JOIN creators c ON c.id = v.creator_id`, dar `videos.creator_id` are cheie străină către **`users`** (`videos_creator_id_fkey`), iar tabela `creators` are 0 rânduri. Fiind `INNER JOIN`, feed-ul verticalelor **nu putea întoarce niciodată nimic** — paginile `/v/[id]` afișau la nesfârșit „fii primul care publică". Confirmat că nu e regresie de la mine (codul vechi întorcea tot 0). Reparat; acum întoarce clipuri reale.
8. **Cod mort eliminat**: expresia inline `RANK_SCORE_EXPR` (definită, nefolosită, cu comentariu fals despre fallback).

### ⚠️ Migrarea trebuie aplicată pe VPS
`20260824_0001_video_rank_fix_events.sql` recreează mat view-ul. Până la aplicare + primul refresh (`/api/cron/refresh-rank`), ranking-ul rulează pe definiția veche.

### Rămase (recomandări, nefăcute — decizii de produs/refactor mare)
- `/api/v1/feed` face HTTP self-fetch spre explore/feed — de extras logica într-o funcție comună (`lib/feed/ranking.ts`) și de spart fișierul de 950 de linii.
- Paginare cu OFFSET peste ordine re-randomizată → cursor-based + seen-tracking real (`user_feed_state` e azi scris doar pe un fallback mort).
- `/api/feed/recommendations` — marcat „extern clients" în antet, dar niciun apelant intern; de confirmat cu consumatorii externi și șters.
- Tabele moarte: `feed_items`, `topics`, `product_topics` (feed-ul folosește lista hardcodată din `lib/topics.ts`).
- Implementarea paralelă Go `/v1/social/like|unlike` scrie în `likes` fără contoare și fără feed_events — de retras sau de aliniat.
- Cold-start pentru anonimi: acum au doar penalizarea de repetare pe session_id + random.

---

## 3. BANI — atomicitate (CRITIC, reparate)

1. **Checkout `create-intent`**: `INSERT commerce_orders` + bucla de items rulau fără tranzacție → eroare la mijloc = comandă `pending` cu items lipsă, ireconciliabilă la webhook. Fix: `withTransaction` pe tot blocul (+ tipizare explicită `CheckoutItem`).
2. **`user_interests`**: DELETE+INSERT ne-tranzacțional în `users/me` → personalizarea putea fi ștearsă ireversibil. Fix: tranzacție.
3. **Variante produs seller**: INSERT per variantă în buclă cu `.catch` înghițit → produse cu variante parțiale. Fix: un singur INSERT multi-VALUES atomic.

4. **N+1 pe calea de plată**: fiecare produs din coș costa 3 tururi secvențiale la DB (produs → variantă → atribuire) ⇒ un coș de 5 produse = 15 tururi înlănțuite. Acum toate item-urile se rezolvă în paralel, iar în interiorul unui item varianta și atribuirea pleacă împreună ⇒ **2 tururi în total**, indiferent de mărimea coșului. Mesajele de eroare rămân identice și în aceeași ordine (primul produs problematic câștigă).
5. **Rezervarea de idempotency nu se elibera la eroare de validare**: userul care corecta coșul și reîncerca cu aceeași cheie primea 409 „în curs de procesare" timp de 60s. Acum se eliberează pe orice eșec de validare.

### Rămase (recomandări)
- **Oversell**: stocul e doar citit-și-comparat la intent; fereastra reală e între intent și plată → necesită sistem de rezervare stoc cu expirare (decizie de produs, nu bug de reparat orbește).

---

## 4. DESIGN — dark mode & tokens

Problema: BottomNav era dark-aware, dar paginile principale de comerț aveau 0 variante `dark:` → nav negru + pagină albă. Reparat cu un workflow de 7 agenți paraleli, paleta-casă din BottomNav aplicată consecvent (light rămâne pixel-identic; doar adaosuri `dark:`):

| Suprafață | Variante `dark:` adăugate |
|---|---|
| `product/[id]/ProductClient.tsx` | 123 |
| `components/ChatInterface.tsx` (homepage) | 157 |
| `cart/page.tsx` | 49 |
| `components/home/*` (OffersFeed, OfferCard, FeedFilterBar) | 59 |
| `food/[slug]/MenuClient.tsx`, `orders/[id]/page.tsx`, `v/[id]/VerticalClient.tsx` | restul (~150) |

Convenție: `bg-white→dark:bg-black` (pagini) / `dark:bg-[#111113]` (carduri), text `#0D0D0D→white`, secundar `#6E6E80→#A1A1AA`, borduri `#E5E5E5→#1F1F1F`, butoane negre inversate `dark:bg-white dark:text-black`. Brand violet + culori semantice neschimbate.

Plus: feedback la eșecul share-ului în explore (înainte: `catch {}` mut).

---

## 5. COD — duplicare eliminată

**Cele două ecrane de notificări** (`/inbox` tab-ul Notificări și `/notifications`) aveau fiecare propria copie a acelorași patru operații: încărcare, mark-all-read, mark-one-read, contor de necitite. Extrase în `lib/notifications/use-notifications.ts` — o singură implementare, cu tratare de erori (înainte, un `fetch` picat arunca necontrolat). Bonus: în inbox, notificările și conversațiile nu mai împart un singur `loading`, deci fiecare tab își arată propriul skeleton în loc să aștepte cererea mai lentă. NotificationsClient: 166 → 96 linii; InboxClient: 365 → 325.

### Rămase (recomandări)
- Accente concurente: CTA-ul verde `#10A37F` din ProductFeed nu există în temă (brand = violet `#7C3AED`) — de decis și tokenizat.
- Hex-urile hardcodate ar merita mutate în tokens Tailwind (o singură sursă).
- Duplicate rămase: monolit auth 1157 linii, 3 playere video copiate, 2 sisteme de save, pagini admin de aprobare suprapuse, ~11 endpoint-uri moarte (listă în istoricul auditului).

---

## 6. PERFORMANȚĂ — audit pe 5 dimensiuni

Metodă: 5 agenți de analiză (SQL feed, indexuri, player video, bundle client, caching), fiecare constatare trecută printr-un verificator adversarial care avea sarcina să o **respingă**. Rezultat: 29 confirmate, 1 respinsă. Lista brută: `perf-findings.txt`, fix-urile complete: `perf-fixes.txt` (artefacte de audit, se pot șterge).

Verificatorii au prins două capcane pe care le-aș fi aplicat altfel: (a) `CREATE INDEX CONCURRENTLY` **nu poate rula prin runner-ul de migrări** al proiectului, care împachetează fișierul în tranzacție (SQLSTATE 25001) — migrarea ar fi eșuat integral; (b) un fix propus pentru pgvector pierdea un `COALESCE`, iar `ORDER BY ... DESC` implică `NULLS FIRST` în Postgres, deci toate clipurile fără embedding ar fi sărit în capul feed-ului.

### Reparate

**Interogări care se executau per rând în loc de o dată pe cerere** (cauza dominantă a lentorii feed-ului):
1. **Afinitatea pe categorii** reagrega 30 de zile de evenimente × clipuri × produse pentru FIECARE clip candidat. Mutată într-un CTE materializat, calculat o dată. `GROUP BY` pe categorie garantează cel mult un rând, deci join-ul nu multiplică rezultatele.
2. **Vectorul de gust (pgvector)** refăcea media peste 1536 de dimensiuni pentru fiecare rând, fiind corelat prin `v.embedding`. Devine CTE + `CROSS JOIN` (media fără `GROUP BY` întoarce mereu exact un rând, deci nu se pierd clipuri). `COALESCE` păstrat explicit — vezi capcana de mai sus.
3. **`mp.id::text` în feed-ul universal** anula cheia primară și forța scanare secvențială peste tot catalogul pentru fiecare clip (~66 de milioane de comparații per cerere). Acum uuid contra uuid, cu regexul evaluat înaintea castului.
4. **Căutarea produsului la checkout** avea aceeași patologie (`p.id::text`), de până la 10 ori per plată. Dispatch în TypeScript: dacă id-ul e UUID, lookup direct pe cheia primară.

**Bug-uri de corectitudine găsite de auditul de performanță:**
5. **`/api/products` servea prețuri în valuta greșită.** Răspunsul e convertit după cookie-ul `swypik_currency`, dar era marcat `public` cu `s-maxage=300` — un cache partajat putea servi prețuri EUR unui vizitator cu RON. Răspunsurile convertite devin `private`; cele în moneda de bază (majoritatea traficului) păstrează cache-ul CDN.
6. **`/api/v1/feed`** marca `public` un răspuns personalizat (ordinea clipurilor + `viewerVote`). Verificatorul l-a judecat neexploatabil azi, dar anteturile invită explicit orice cache partajat, iar Cloudflare e în față — închis oricum: `private` când cererea poartă cookie.
7. **Clipul sărea la început la fiecare like.** Observer-ul se reconstruia la orice schimbare a listei, iar re-observarea derula clipul la secunda 0 și dubla impresiile. Rezolvat cu o gardă pe schimbarea reală de clip activ. Cheia efectului e acum SETUL de id-uri — nu lungimea, care ar fi blocat complet feed-ul la comutarea „Pentru tine ↔ Urmăriți" (30 de clipuri înlocuite cu alte 30).
8. **Clipuri vecine rulau în fundal la nesfârșit**: când fluxul HLS al unui vecin dădea 404 (stare normală cât e în procesare), fallback-ul pornea redarea în afara ecranului, în buclă. Acum repornește doar dacă acel clip chiar rula. În plus, elementul video e oprit și detașat la demontare pe toate căile (înainte, doar pe cea hls.js).

**Reziliență:**
9. **Pool-ul de baze de date nu avea plafon de durată** — o singură interogare degradată putea ocupa toate cele 15 conexiuni și pica în cascadă checkout-ul și autentificarea. Adăugat `statement_timeout` (15s, configurabil) + `idle_in_transaction_session_timeout`. **Atenție**: asta ar fi rupt refresh-ul de ranking, care depășește legitim plafonul — de aceea am adăugat `dbQueryLong()` pentru operațiile de mentenanță.
10. **Timeout-uri pe apeluri externe**: platform-api Go era nelimitat, Stripe rula pe default-ul de 80s (prea mult pentru un user care așteaptă în pagina de plată).
11. **Scriere pe cea mai fierbinte cale de citire**: fiecare cerere de feed a unui vizitator anonim actualiza `last_seen_at` — tuplă moartă + WAL + indexuri, la fiecare pagină de scroll. Acum se rescrie doar dacă marcajul e mai vechi de 15 minute.

**Indexuri** (`db/migrations/20260824_0002_hot_path_indexes.sql`, fără `CONCURRENTLY` — tabele mici, build de zeci de ms): comentarii top-level vizibile, produse active sortate cronologic. Indexurile pe `feed_events` (tabel mare, scriere intensă) sunt în `scripts/db/concurrent-indexes.sql`, de rulat **manual**, în afara oricărei tranzacții — cu instrucțiuni pentru cazul în care un build eșuat lasă un index invalid.

**Bundle**: `recharts` (~107 kB gz) se încărca pe calea critică a dashboard-ului de creator, înainte ca datele graficului să fie cerute — mutat în `next/dynamic`.

### Încercat și RETRAS (măsurat, nu presupus)
**Sentry tree-shaking.** Am aplicat `withSentryConfig` cu `removeDebugLogging` și am măsurat: bundle-ul partajat a **crescut** 185 → 188 kB, pentru că plugin-ul adaugă mai mult decât scoate cât timp tracing-ul rămâne activ. Am revocat schimbarea. Câștigul real (~22-49 kB pe fiecare pagină) cere `removeTracing: true`, care **dezactivează complet performance monitoring-ul** — decizie de produs, a ta. Motivul e notat în `next.config.mjs` ca să nu reîncerce nimeni orbește.

### Rămase (cele mai mari, necesită decizii sau lucrări ample)
- **Feed fără cache**: sortarea evaluează 7-9 subinterogări corelate pentru fiecare clip eligibil ca să livreze 20. Un strat Redis în față (per viewer, TTL scurt) e cel mai mare câștig rămas.
- **Overfetch**: se aduc 121 de rânduri din care ~91 se aruncă în JS, iar OFFSET-ul avansează doar cu 30 ⇒ paginile se suprapun pe ~75%. Cere paginare pe cursor.
- **i18n**: toate cele 162 de namespace-uri (117 kB JSON) ajung în payload-ul fiecărei pagini, necache-abil (~42 kB gz pe fiecare încărcare la rece).
- **`cookies()` în layout-ul rădăcină** scoate întreaga aplicație din randare statică — nicio pagină nu e preprodusă.
- **Video**: segmente HLS de 6s + `startLevel: 0` ⇒ time-to-first-frame 1.5-2.5s față de ~200-400ms la TikTok; ladder-ul e landscape deși feed-ul e vertical (conținutul portret ajunge codat la 202px lățime); posterele sunt JPEG la rezoluția sursă (300-600 kB în loc de ~25 kB). Astea cer schimbări în pipeline-ul de procesare video.
- Agregatele de echitate se recalculează per clip deși sunt constante per creator.

---

## 7. Fișiere modificate

Nucleu: `app/api/videos/[id]/like/route.ts`, `app/api/comments/[id]/like/route.ts`, `app/api/videos/[id]/comments/route.ts`, `app/api/v1/feed/route.ts`, `app/api/explore/feed/route.ts`, `app/api/feed/universal/route.ts`, `app/api/products/[id]/{like,share}/route.ts`, `app/api/checkout/create-intent/route.ts`, `app/api/users/me/route.ts`, `app/api/seller/products/route.ts`, `app/[locale]/explore/ExploreClient.tsx`, `components/ProductFeed.tsx`, `components/social/CommentsSheet.tsx`, `lib/{algo/scoring,chat/feed-normalize,notifications/dispatch,security/rate-limit,social/comments}.ts`, `types/product.ts`, `app/[locale]/account/AccountPageClient.tsx` + fișierele de design din §4.

Performanță: `lib/db.ts`, `lib/db/product-queries.ts`, `lib/social/session.ts`, `lib/social/proxy.ts`, `lib/stripe/checkout.ts`, `lib/video/useHlsVideo.ts`, `app/api/products/route.ts`, `app/api/cron/refresh-rank/route.ts`, `app/creator/(dashboard)/analytics/AnalyticsClient.tsx`.

Fișiere noi: `db/migrations/20260824_0001_video_rank_fix_events.sql`, `db/migrations/20260824_0002_hot_path_indexes.sql`, `scripts/db/concurrent-indexes.sql`, `lib/notifications/use-notifications.ts`, `tests/unit/feed-normalize.test.ts`, `app/creator/(dashboard)/analytics/TrendChart.tsx`.
Refactorizate: `app/[locale]/inbox/InboxClient.tsx`, `app/[locale]/notifications/NotificationsClient.tsx`.

**Deploy** — pe fluxul din CLAUDE.md (VPS = sursa de adevăr), în ordinea asta:
1. Merge branch-ul în `mvp-freeze` pe VPS.
2. Aplică migrările `20260824_0001` (ranking) și `20260824_0002` (indexuri) prin runner-ul obișnuit.
3. Rulează **manual**, statement cu statement, `scripts/db/concurrent-indexes.sql` (NU prin runner — vezi explicația din fișier).
4. Rebuild `web-next` + `up -d --force-recreate --no-deps web-next`.
5. Forțează un `/api/cron/refresh-rank` ca mat view-ul recreat să se populeze.
6. Smoke: `/api/explore/feed`, `/api/feed/universal`, un like, un „Nu mă interesează", un checkout de test.

**De verificat după deploy**: `EXPLAIN ANALYZE` pe interogarea de feed pentru un user logat (înainte/după), ca să confirmi câștigul din CTE-uri pe date reale — estimările din audit sunt structurale, nu măsurători pe producție.
