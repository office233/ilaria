# Swypik Movies — design

**Data:** 2026-09-21 · **Stare:** decizii de produs primite, spec de aprobat · **Următorul pas:** plan de implementare (writing-plans) după „da"

## 1. Decizii de produs (confirmate de Tibor pe 2026-09-21)

| Decizie | Valoare |
|---|---|
| Cine publică | **Admin + creatori verificați** („publisher Movies", aprobat de admin). **Primul creator este contul oficial Swypik** (`lib/config/accounts.ts`, `NEXT_PUBLIC_SWYPIK_OFFICIAL_USER_ID`). |
| Plata episoadelor | **SWYP** (ledger-ul existent, `spendSwyp`). Fără Stripe în MVP. |
| Plata creatorilor | **SWYP, cotă din fiecare deblocare**, creditată instant în portofelul creatorului (retragere prin `/api/swyp/withdraw`, care există). |
| Navigație | Intrare **„Swypik Movies" în meniul hamburger** (`components/home/CategorySidebar.tsx`, lista de module super-app). |
| Feed | **Episoadele gratuite apar și în feed-ul video** (`/explore`), marcate „Swypik Movies · Ep. 1/40", cu CTA „Vezi serialul". |
| Pagina Movies | **„Super cinematic"**: hero full-bleed cu trailer HLS mut, carusele de postere, Top 10, „Continuă să vezi", temă întunecată. |

Valori implicite (recomandate, ajustabile din admin fără cod): 3 episoade gratuite per serial; episod ≤ 180 s; prețul per episod îl setează publisher-ul între limite globale (`MOVIES_EPISODE_PRICE_MIN/MAX_UNITS`); sezonul întreg = suma episoadelor blocate × `MOVIES_SEASON_DISCOUNT_PCT` (implicit 40 % reducere).

## 2. „Cea mai bună variantă" — recomandarea pentru plata creatorilor

**Cotă din deblocare, la momentul deblocării (recomandat).** Când un viewer plătește un episod sau un sezon:

1. `spendSwyp`: viewer → pool `rewards` (suma întreagă), `refType: "movie_unlock"`, `refId: unlockId` — idempotent.
2. În **aceeași tranzacție DB** (`swypTransferInTx`): pool `rewards` → creator, `share = amount × MOVIES_CREATOR_SHARE_BPS / 10 000` (implicit **7000 = 70 %**), `refType: "movie_creator_share"`, același `refId`.
3. Dacă `owner_user_id` este contul oficial Swypik, pasul 2 se sare — cota rămâne în pool (platforma nu se plătește pe sine).
4. Rândul `movie_unlocks` stochează `units_paid`, `creator_share_units`, `ledger_ref`; un cron de reconciliere (tiparul din `reconcile-wallets`) verifică zilnic că `SUM(creator_share_units)` = intrările din ledger.

De ce nu alternativele:
- **Fond distribuit pe timp de vizionare** — exact vectorul de fraudă din auditul B-02 (`watch_ms` anonim, neplafonat). Respins.
- **Plată lunară batch** — întârzie banii creatorului cu până la 30 de zile și adaugă un cron cu bani; nu aduce nimic în plus față de creditarea instant idempotentă.
- **Abonament (Movies Pass)** — trebuie o cheie de repartizare pe vizionări (din nou timp de vizionare). Fază 2, doar cu vizionări de la conturi plătitoare verificate.

Anti-fraudă minimă în MVP: un creator nu poate debloca propriile episoade cu cotă (share = 0 pentru `viewer == owner`), rate-limit pe deblocări, `MOVIES_CREATOR_DAILY_CAP_UNITS` opțional pe cota zilnică per creator (ca `daily_cap_units` la reguli).

## 3. Abordare tehnică

**Tabele dedicate + reutilizarea `videos`.** Fiecare episod este un rând `videos` (upload, transcodare HLS, moderare, captions, like/comment, `video_product_links` pentru „cumpără din scenă" funcționează neschimbate), iar structura de serial/episod/preț/deblocare stă în tabele proprii, tipizate. Respinse: totul în `videos.metadata` (JSON netipizat, paywall fragil) și serviciu Go separat (dublează auth/ledger/i18n).

## 4. Design

### 4.1 Model de date — `db/migrations/20260922_0001_movies.sql`

```
movie_publishers        -- cine are voie să publice (admin aprobă)
  user_id uuid PK → users · approved_by uuid → users · approved_at timestamptz · note text

movie_series
  id uuid PK · slug text UNIQUE · owner_user_id uuid → users (publisher)
  title · synopsis · genres text[] · language_code text
  cover_url text (16:9, hero) · poster_url text (9:16) · trailer_video_id uuid → videos NULL
  status text draft|pending_review|published|archived
  free_episodes int DEFAULT 3 CHECK (0..10) · episode_price_units bigint · season_price_units bigint
  is_adult bool DEFAULT false · license_note text (obligatoriu la publicare)
  published_at · created_at · updated_at

movie_episodes
  id uuid PK · series_id → movie_series ON DELETE CASCADE · episode_number int CHECK (> 0)
  video_id uuid → videos UNIQUE · title text · duration_ms int
  status text draft|published · created_at · updated_at
  UNIQUE (series_id, episode_number)

movie_unlocks
  id uuid PK · user_id → users · series_id → movie_series · episode_id → movie_episodes NULL (NULL = sezon)
  units_paid bigint · creator_share_units bigint · ledger_ref text · created_at
  UNIQUE (user_id, episode_id)  (parțial: WHERE episode_id IS NOT NULL)
  UNIQUE (user_id, series_id)   (parțial: WHERE episode_id IS NULL)

movie_watch_progress
  user_id → users · episode_id → movie_episodes · position_ms int · completed bool · updated_at
  PK (user_id, episode_id)
```

Reguli pure în `lib/movies/access.ts` și `lib/movies/pricing.ts` (testate unitar, fără DB):
- `isFreeEpisode(series, episode) = episode_number ≤ free_episodes`
- `canPlay(viewer, series, episode) = isFree || unlockEpisode || unlockSeason || viewer === owner || viewer.isAdmin`
- `seasonPriceUnits(series, episodes) = round(Σ preț episoade blocate × (1 − discount))`
- `creatorShareUnits(amount, ownerId, viewerId) = ownerId ∈ {official, viewer} ? 0 : floor(amount × bps / 10000)`

### 4.2 API (route handlers cu `withErrorHandling`, zod, rate-limit, `FEATURE_MOVIES`)

| Rută | Rol |
|---|---|
| `GET /api/movies` | catalog paginat: `?genre=&sort=trending\|new&cursor=`; doar `published`; `is_adult` ascuns pentru neverificați; include „Continuă să vezi" pentru userul logat |
| `GET /api/movies/[slug]` | serial + episoade cu `locked`, `priceUnits`, progres |
| `GET /api/movies/[slug]/episodes/[n]/play` | **unicul** loc care dă URL-ul de redare: 402 `{ reason: "locked", priceUnits, seasonPriceUnits, balanceUnits }` dacă nu are drept; altfel `playbackUrl` (vezi 4.5) + `videoId` pentru like/comment/captions |
| `POST /api/movies/[slug]/unlock` | `{ episodeId }` sau `{ season: true }` → tranzacția din §2; 402 `insufficient_balance`, 409 `already_unlocked` (idempotent, întoarce 200 cu `alreadyApplied`) |
| `POST /api/movies/progress` | `{ episodeId, positionMs, completed }`, `sendBeacon` la 5 s și la părăsire |
| `GET/POST /api/creator/movies`, `PATCH /api/creator/movies/[id]`, `POST /api/creator/movies/[id]/episodes` | studio-ul publisher-ului: creează serial (draft), atașează episoade din `videos` proprii cu `status='ready'`, trimite la review |
| `GET/PATCH /api/admin/movies`, `POST /api/admin/movies/publishers` | aprobare publisheri, review/publicare seriale, editare prețuri și `free_episodes` |

### 4.3 UI (`app/[locale]/movies/…`, `next-intl` namespace `movies`, 7 locale de la început)

- **`/movies` (cinematic):** hero 100 vh cu trailerul serialului featured redat mut în loop (`useHlsVideo`), gradient spre negru, titlu mare, „Vezi acum" / „+ Lista mea"; rânduri orizontale cu snap: „Continuă să vezi" (bară de progres pe poster), „Top 10 în România" (numere mari suprapuse), pe genuri; postere 9:16 cu hover/press scale, temă `bg-black`, tipografie condensată, fără chrome-ul standard (BottomNav ascuns pe `/movies`, ca pe `/go`).
- **`/movies/[slug]`:** poster full-bleed cu vignetă, sinopsis, gen, „Ep. 1 gratuit" / „Continuă ep. 7", grilă de episoade (lacăt + preț pe cele blocate), „Deblochează sezonul — X SWYP (−40 %)", produsele din scenă.
- **`/movies/[slug]/[n]` (player):** full-screen 9:16, scroll-snap vertical = episodul următor (ca `ExploreClient`), auto-next la final, overlay minimal (titlu, `Ep. 7/40`, like/comment/share, „Cumpără din scenă", subtitrări), puncte de progres sus. Un episod blocat este un slide-paywall: preț, sold SWYP, „Deblochează episodul" / „Deblochează sezonul", fără leak de URL.
- **Feed (`/explore`):** episoadele gratuite (`episode_number ≤ free_episodes`, serial `published`) intră în feed prin JOIN pe `movie_episodes`; overlay „Swypik Movies · Ep. 1/40" + CTA „Vezi serialul" → `/movies/[slug]/1`. Episoadele blocate **nu** intră niciodată în feed.
- **Hamburger:** intrare „Swypik Movies" în `CategorySidebar` (brand/label/badge „Nou"), gated de `NEXT_PUBLIC_FEATURE_MOVIES`.
- **Creator Studio (`/creator/movies`):** lista serialelor mele, „Serial nou", atașare episoade din clipurile proprii `ready`, preț, episoade gratuite, trimite la review; câștiguri SWYP din Movies în dashboard-ul existent.
- **Admin (`/admin/movies`):** publisheri (aprobare), review seriale, publicare, editare prețuri.

### 4.4 Ledger
- Toate mișcările prin `swypTransferInTx` într-o singură tranzacție: debit viewer + credit creator + `INSERT movie_unlocks`. ROLLBACK anulează tot.
- `kind` pentru credit-ul creatorului: `"reward"` cu `refType: "movie_creator_share"` (tipul `SwypTransferArgs.kind` existent), sau un `kind` nou `"creator_share"` dacă vrem raportare separată — decis în plan, după verificarea CHECK-urilor din ledger.
- Fără „SWYP pentru vizionare" în MVP.

### 4.5 Paywall real
- Episoadele **gratuite** rămân pe URL-urile publice R2 (ca orice clip din feed).
- Episoadele **blocate** se stochează sub prefixul privat `movies/locked/…` în bucket-ul video; `play` întoarce un **URL presemnat** (`@aws-sdk/s3-request-presigner`, deja dependență) cu TTL 10 min pentru playlist-ul HLS; segmentele sunt referite relativ, deci cer fie presemnare per segment (playlist rescris server-side), fie un proxy `/api/movies/stream/[token]/…` care validează token-ul și transmite din R2. **Decizie pentru plan:** proxy cu token semnat (HMAC, expiră în 10 min, legat de user + episod) — simplu, fără rescrierea playlist-urilor; costul de egress R2 este zero.
- Nu este DRM; scopul e ca un URL copiat să nu funcționeze după 10 minute și să nu poată fi ghicit.

### 4.6 Moderare, siguranță
- Episoadele intră în `videos` cu `moderation_status='pending_review'`; serialul se publică doar când toate episoadele sunt `approved` și `license_note` e completat.
- `is_adult` ⇒ filtrat pentru neverificați (același predicat ca feed-ul).
- Rate-limit: `moviesUnlock` 10/min, `moviesProgress` 60/min, `moviesPublish` 5/h.

### 4.7 Feature flag
`FEATURE_MOVIES` + `NEXT_PUBLIC_FEATURE_MOVIES` (OFF): rute 410, pagini 404, fără intrare în meniu — tiparul `squadBuy`.

## 5. Faze

1. **MVP:** migrare, `lib/movies/*` (TDD), API §4.2, Creator Studio minim, Admin minim, `/movies` cinematic, pagina serialului, player + paywall + deblocare + cotă creator, progres, feed, hamburger, i18n, flag. Primul serial publicat sub contul oficial Swypik.
2. Notificări „episod nou", „Lista mea", trailer per serial, reconciliere cron pentru cote.
3. Movies Pass (Stripe) cu repartizare pe vizionări verificate, descărcare offline, recomandări.

## 6. Testare
- Unit (`tests/unit/movies-*.test.ts`): `canPlay`, `seasonPriceUnits`, `creatorShareUnits` (0 pentru owner/official/self-unlock), idempotența unlock-ului cu DB mock (tiparul `squad-buy.test.ts`).
- API: 402 pe episod blocat, 200 după unlock, share creditat o singură dată la retry, token de stream expirat → 403, episod blocat absent din feed.
- E2E (Playwright): catalog → serial → ep. 1 gratuit → paywall ep. 4 → deblocare → redare → progres reluat.

## 7. Riscuri
- **Licențe** — `license_note` obligatoriu și review admin; fără seriale licențiate verticalul e gol.
- **Transcodare** — 40 episoade × 3 min per serial pe worker-ul existent; de măsurat capacitatea înainte de primul serial mare.
- **Fraudă la cote** — self-unlock blocat, rate-limit, cap zilnic opțional; monitorizare în cron-ul de reconciliere.
