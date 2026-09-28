# EXPLORE_REDESIGN_SPEC — Audit /explore (feed video) + Spec redesign TikTok-style

Data audit: 2026-08-02 · Mod: READ-ONLY (audit de cod, fără modificări sursă)
Fișiere principale auditate:
- `app/[locale]/explore/page.tsx` (server component, wrapper)
- `app/[locale]/explore/ExploreClient.tsx` (943 linii — tot UI-ul feed-ului, inclusiv CSS injectat)
- `app/[locale]/explore/loading.tsx`
- `components/social/CommentsSheet.tsx`
- `components/ProductDrawer.tsx`
- `components/BottomNav.tsx`

---

## 1. STAREA ACTUALĂ

### 1.1 Structura generală
- `ExploreClient.tsx:1` — `"use client"`; componenta `ExplorePageInner` e împachetată în `<Suspense>` de `ExploreClient` (`ExploreClient.tsx:936-943`).
- Root: `<main className="explore-root" aria-label="Discover videos">` — `ExploreClient.tsx:588`.
- Tot CSS-ul e injectat inline prin `<style dangerouslySetInnerHTML>` — `ExploreClient.tsx:590` și urm. (nu există fișier CSS separat / Tailwind pentru feed).
- Variabile CSS de layout: `--feed-bottom-nav: 64px`, `--feed-safe-bottom`, `--feed-action-bottom`, `--feed-content-bottom` — `ExploreClient.tsx:592`.

### 1.2 Scroll & snap — EXISTĂ deja snap
- `.feed-scroll { overflow-y: scroll; scroll-snap-type: y mandatory; -webkit-overflow-scrolling: touch; }` — `ExploreClient.tsx:595`.
- `.video-slide { height: 100dvh; scroll-snap-align: center; }` — `ExploreClient.tsx:597`.
- Container: `<div ref={containerRef} className="feed-scroll">` — `ExploreClient.tsx:741`.
- IntersectionObserver pentru play/pause + tracking `currentIndex` — `ExploreClient.tsx:272` și urm.
- Virtualizare ușoară: doar sliderele cu `Math.abs(idx - currentIndex) <= MOUNT_RADIUS` montează `<FeedVideo>`, restul afișează poster — `ExploreClient.tsx:755-790`.
- Infinite load la ultimele ~3 videouri — `ExploreClient.tsx:264-270`.

### 1.3 Bara de acțiuni (action-bar) — deja verticală, în dreapta
- Container: `.action-bar { position: absolute; right: max(10px,…); bottom: var(--feed-action-bottom); flex-direction: column; gap: 18px; z-index: 22; }` — `ExploreClient.tsx:643`; JSX: `ExploreClient.tsx:862`.
- Butoane (toate cu `aria-label` tradus prin `t(...)` din namespace `explore`):
  - **Avatar creator + buton follow (+)** — `ExploreClient.tsx:864-873` (`.avatar-plus`, aria-label `t("urmareste")` la :871).
  - **Apreciază** (`aria-label={t("apreciaza")}`, Heart, toggle `likedVideos`) — `ExploreClient.tsx:875-878`.
  - **Discuții** (`aria-label={t("discutii")}`, MessageCircle, deschide CommentsSheet prin `setActiveCommentsVideo(video)`) — `ExploreClient.tsx:879-882`.
  - **Salvează** (`aria-label={t("salveaza")}`, Bookmark, toggle `savedVideos`) — `ExploreClient.tsx:883-886`.
  - **Distribuie** (`aria-label={t("distribuie")}`, Share2, `handleShare`) — `ExploreClient.tsx:887-890`.
- Stiluri butoane: `.action-btn` min 48×48px, icon-wrap 44px, count sub icon — `ExploreClient.tsx:644-647`.

### 1.4 Contoare — deja formatate 1.2K/1.2M
- `formatCount()` — `ExploreClient.tsx:580-585`: `>=1M → X.XM`, `>=1000 → X.XK`, altfel număr brut. Aplicat pe likes/comments/saves/shares (`:877, :881, :885, :889`).
- Stil: `.action-btn .count { font-size: 12px; font-weight: 600; tabular-nums; }` — `ExploreClient.tsx:647`.

### 1.5 Comentarii
- `CommentsSheet` importat dynamic (`ssr:false`) — `ExploreClient.tsx:16`; state `activeCommentsVideo` — `:91`; montare + `onCountChange` — `ExploreClient.tsx:921-931`.
- Sheet: overlay `fixed inset-0 z-[100]`, backdrop buton „Inchide comentariile", secțiune `role="dialog" aria-modal h-[68vh] max-h-[720px]` — `CommentsSheet.tsx:232-234`.
- Formular jos: `paddingBottom: max(12px, env(safe-area-inset-bottom))` — `CommentsSheet.tsx:290`; textarea placeholder `"Adauga un comentariu..."` / `"Scrie un raspuns..."` — `CommentsSheet.tsx:298`; buton submit `aria-label="Trimite comentariul"` — `CommentsSheet.tsx:307`.
- Reply UI („Raspunzi lui …" / „Renunta") — `CommentsSheet.tsx:281-288` (tot fără diacritice).

### 1.6 Descriere + zona de jos (bottom-content)
- `.bottom-content { position:absolute; bottom: var(--feed-content-bottom); … z-index: 20 }` — `ExploreClient.tsx:654`.
- `.creator-name` — `:655`; `.video-desc { -webkit-line-clamp: 2; overflow: hidden; }` — `ExploreClient.tsx:656` → descrierea e TRUNCHIATĂ la 2 rânduri, **fără expandare** (nu există state/handler „mai mult").
- `.music-ticker` (marquee sunet) — `ExploreClient.tsx:664-667`.

### 1.7 Atașarea produsului
- **Product cockpit** (card produs peste video, când `video.product?.id`): `<section className="product-cockpit" aria-label={t("actiuniProdus"…)}>` — `ExploreClient.tsx:807-858`. Conține:
  - link creator + `verdict-pill` (Sparkles) — `:809-818`;
  - buton principal `aria-label="Deschide produsul"` (imagine, titlu, preț, SwypikScore) → `openProduct(video)` — `ExploreClient.tsx:820-839`;
  - butoane „Alternative" (→ /search) și „Coș" (`handleAddProductToCart`, `+10 XP`, `add_to_cart` tracking la `:563-565`) — `:841-857`.
  - Notă: `aria-label="Deschide produsul"` la `:820` este HARDCODAT (netranslatat), spre deosebire de restul.
- **ProductDrawer** (`components/ProductDrawer.tsx`) se deschide din cockpit: overlay `z-[90]` + sheet `h-[70vh] z-[100]` — `ProductDrawer.tsx:260, 271`; `onVoteChange`/`onBuyNow` legate în `ExploreClient.tsx:899-918`.
- `.product-chip` există și ca stil alternativ — `ExploreClient.tsx:657`.
- Mute/unmute pe tap video (`onTap={toggleMute}`) — `ExploreClient.tsx:775`; NU există double-tap like.

### 1.8 Header feed
- Topbar cu căutare AI (`aiPrompt` → `/search?q=`) — `ExploreClient.tsx:576-578, 685+`.
- Tab-uri Following / For You (`feed-header`, role=tablist) — `ExploreClient.tsx:712-733`; tab-uri de format — `:700-708`.

---

## 2. COD VECHI DE VOT

- **`app/[locale]/post/[slug]/VoteButtons.tsx`** — componentă client de vot pe pagina de post (`post/[slug]/page.tsx:5, :195`). NU e folosită în /explore. Cod separat, vizibil doar pe `/post/[slug]`.
- **`video_product_votes`** (tabel DB) — folosit exclusiv de API `app/api/videos/[id]/product-vote/route.ts` (`:27, :104-121` — upsert vot `worth_it`/`not_worth_it`, suport user sau session).
- **Consumator UI al votului**: `components/ProductDrawer.tsx` — secțiunea „Vot comunitate": state `votePending` (`:74`), calcule voturi (`:162-166`), optimist (`:173`), fetch `product-vote` (`:201`), butoanele worth_it/not_worth_it (`:354-…`, `aria-pressed`, grid 2 coloane, `t("votComunitate")` la `:346`).
- **În /explore votul NU e vizibil direct** — apare doar după deschiderea ProductDrawer (via cockpit). Nu există buton „Votează" în action-bar. Nu există fișier `components/VoteButtons.tsx`; singurul `VoteButtons` e cel din `post/[slug]`.
- Concluzie: nu e cod mort, dar e un flux „ascuns" (2 tap-uri distanță); de decis în redesign dacă votul rămâne în drawer sau se promovează în cockpit.

---

## 3. BUG-URI UX CONFIRMATE (din testare la viewport 390×844)

### 3a. Bottom-nav interceptează click-urile
- Componentă: **`components/BottomNav.tsx:41`** — `<nav data-testid="bottom-nav" className="fixed bottom-0 left-0 right-0 z-30 …">` (înălțime h-16 = 64px, `z-30`).
- Simptom 1: click pe **„Trimite comentariul"** din CommentsSheet e interceptat. Deși sheet-ul are `z-[100]` (`CommentsSheet.tsx:232`) — teoretic peste `z-30` — formularul (`CommentsSheet.tsx:290`) are doar `paddingBottom: max(12px, env(safe-area-inset-bottom))`; în browser desktop-emulat `safe-area-inset-bottom=0`, deci butonul submit (`:307`) ajunge în banda de 64px a nav-ului. Dacă contextul de stacking al sheet-ului e compromis (părinte cu transform/filter din layout) sau Playwright decide hit-target pe nav, click-ul cade pe nav. Fix: (1) `paddingBottom: calc(64px + env(safe-area-inset-bottom))` pe form SAU (2) ascunde `BottomNav` cât timp un sheet e deschis (ex. atribut `data-sheet-open` pe body + `pointer-events:none` pe nav) SAU (3) montează sheet-ul în portal direct pe `document.body`.
- Simptom 2: butonul **„Salvează"** din `/account/edit` — `app/[locale]/account/edit/page.tsx` — pagina are `pb-24` (`:193`) și există deja un comentariu care recunoaște problema: `„deasupra bottom-nav (h-16, z-30) — altfel nav-ul interceptează click-urile pe mobil"` (`page.tsx:389`); butonul fix de la `:383+` folosește `bottom-24 z-30` — **egal** cu z-30 al nav-ului, deci ordinea DOM decide. Fix: `z-40` (sau mai mare) pe containerul butonului Salvează, sau `bottom` mai mare.
- Recomandare sistemică: definește o scară de z-index documentată: nav=30, conținut fix pagină=40, drawere/sheets=100, toast=110.

### 3b. Diacritice lipsă
- `CommentsSheet.tsx:298` — placeholder `"Adauga un comentariu..."` → corect: `"Adaugă un comentariu…"`; tot acolo `"Scrie un raspuns..."` → `"Scrie un răspuns…"`.
- Conex, tot hardcodate fără diacritice/i18n în `CommentsSheet.tsx`: `:233` „Inchide comentariile", `:283` „Raspunzi lui", `:285` „Renunta". Fix recomandat: mutare în `messages/*` (namespace `social.comments`) cu diacritice corecte.
- Similar: `loading.tsx:4` aria-label „Se incarca".

---

## 4. SPEC REDESIGN TikTok-STYLE

Baza e deja bună (snap mandatory, action-bar verticală dreapta, contoare 1.2K). Redesignul e incremental:

| # | Recomandare | Componentă de modificat |
|---|---|---|
| 1 | **Action-bar**: păstrează ordinea TikTok (avatar+follow, like, comentarii, salvează, share); mărește gap la scroll mic; adaugă animație „pop" pe like (scale+heart burst). Tradu `aria-label="Deschide produsul"` (:820). | `app/[locale]/explore/ExploreClient.tsx` (:643-653, :862-891, :820) |
| 2 | **Contoare**: `formatCount` OK; opțional elimină `.0` (1.0K→1K) și adaugă update optimist deja existent. | `ExploreClient.tsx:580-585` |
| 3 | **Bottom-sheet comentarii deasupra bottom-nav**: form cu `paddingBottom: calc(var(--feed-bottom-nav,64px) + env(safe-area-inset-bottom) + 12px)` sau ascunde nav-ul când sheet-ul e deschis; montează în portal (`createPortal(document.body)`); corectează diacriticele + i18n. | `components/social/CommentsSheet.tsx` (:232, :290, :298, :307) + `components/BottomNav.tsx:41` |
| 4 | **Snap-scroll obligatoriu**: deja `scroll-snap-type: y mandatory` (:595) — păstrează; adaugă `overscroll-behavior-y: contain` pe `.feed-scroll` ca pull-to-refresh accidental să nu iasă din feed. | `ExploreClient.tsx:595-597` |
| 5 | **Descriere expandabilă**: state `expandedDesc:Set<videoId>`; tap pe `.video-desc` comută `-webkit-line-clamp: 2` ↔ `unset` + fundal gradient mai închis când e expandată; buton „mai mult/mai puțin". | `ExploreClient.tsx` (:654-656 CSS + JSX bottom-content) |
| 6 | **Double-tap like**: în `FeedVideo` `onTap` face acum doar mute-toggle (:775); implementează detectare dublu-tap (2 tap-uri <300ms) → `handleLike(video.id)` + animație inimă mare centrată; single-tap rămâne mute (cu delay 300ms) sau se mută mute pe butonul Volume existent. | `ExploreClient.tsx` (`FeedVideo`, handler `onTap` :775) |
| 7 | **Vot produs mai vizibil**: promovează „Merită / Nu merită" din ProductDrawer (:343-…) ca pill-uri compacte în product-cockpit, reutilizând API `product-vote`. | `ExploreClient.tsx` (cockpit :807-858) + `components/ProductDrawer.tsx` |
| 8 | **Z-index systematizat**: nav z-30 < fixe pagină z-40 < gradient/actiuni feed (20-22, absolute în slide — OK) < drawere z-[100] < toast z-[110]; toast-ul din explore are `zIndex:100` (:738) — ridică la 110. | `BottomNav.tsx:41`, `ExploreClient.tsx:738`, `ProductDrawer.tsx:260/271`, `CommentsSheet.tsx:232`, `account/edit/page.tsx:383` |
| 9 | **CSS**: extrage `<style dangerouslySetInnerHTML>` (:590-683) într-un modul CSS (`explore.module.css`) pentru mentenanță și evitarea re-parsării la fiecare render. | `ExploreClient.tsx:590+` |

Prioritate: 3 (bug blocant comentarii) > 3a-edit (bug Salvează) > 6 (double-tap) > 5 (descriere) > restul.
