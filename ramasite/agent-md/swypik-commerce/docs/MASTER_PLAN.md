# SWYPIK MASTER PLAN — Social Commerce + Video + AI + Live + Adult Vault

> **Versiune**: 2026-05-13 (final, cu toate cele 40 idei moderne integrate)
> **Repo live**: `/opt/swypik/app` pe Hetzner VPS `46.224.197.2`
> **Mirror**: github.com/office233/aicevrei

---

## 1. CONTEXT

Swypik = platforma TikTok-style pentru **social commerce** (video feed → produs → checkout) + **creator economy** (rewards, paid content, live, tips) + **AI assistant** end-to-end. Audit-ul recent (2026-05-12) a aratat:
- **77 tabele Postgres** (schema acopera ~95% din feature-urile MVP — feed events, collections, SWYP wallets, daily challenges, video pipeline, fulfillment, moderation, DM, paid)
- **Stack**: Next.js 14 (App Router) + Go platform-api (creator video + ranking) + Python video-worker (FFmpeg HLS) + Postgres 16 + Redis 7 + Caddy + Cloudflare R2
- **75-80% MVP scris in cod** dar nu tot wired end-to-end
- **8 module frozen** acum (DM, push, stripe-connect, fulfillment, returns, email mkt, SEO best, AI chat full) — feature flags in `lib/feature-flags.ts`

**Cerinte din 3 documente user**:
1. **MVP adictiv** — feed instant, onboarding rapid, ranking event-driven, save/collections, more-like-this, AI assist, creator hooks, daily challenges, social proof, 5 loops
2. **Plan de bataie** — 12 blocuri infra→storage→video→feed→catalog→import→checkout→fulfillment→seller→creator→admin→siguranta
3. **Viitor** — 5 faze de scalare: Launch → Stabilizare → Growth → TikTok-style → TikTok-level infra

**Cerinte din sesiunea curenta**:
- **Live streaming** + tips/donations (creator live, viewer tips)
- **18+ vault separat** — produse + clipuri adult, filtrate complet din feed normal, tab dedicat dupa age verify
- **Creator paid content (OnlyFans-style)** — subscription / pay-per-video / pay-per-live, include si 18+ paid
- **AI Chat Assistant** reactivat, raspunde streaming, function calling
- **Bottom nav TikTok-style** mobile-first
- **In-app camera record** (nu doar upload)
- **Mobile-first OBLIGATORIU** pe orice pagina

**Plus 40 idei moderne (din brainstorm sesiune curenta)** integrate in fazele potrivite mai jos.

---

## 2. FILOSOFIE

> **Construieste TikTok-style la PRODUS de la inceput, dar TikTok-level la INFRASTRUCTURA doar cand traficul o cere.**

- **DA**: feed instant, ranking event-driven, save/collections, creator rewards, challenges, AI assist, social proof, drops, BNPL, AR — costa ieftin, fac diferenta
- **NU acum**: multi-region, K8s, autoscaling, blockchain, coin propriu, dedicated encoding farm — vin cand metricile o cer
- **Mobile-first absolut**: fiecare pagina + componenta se face pe mobil PRIMA, desktop = bonus
- **Live streaming si AR try-on = ULTIMELE** (cele mai scumpe + complexe), dupa restul e stabil

---

## 3. WORKFLOW OPERATIONAL

```
SSH pe VPS:    cd /opt/swypik/app
  ↓
git checkout -b task/<nume-scurt>
  ↓
edit + test pe VPS (docker compose build web-next && up -d --force-recreate)
  ↓
smoke test live (curl + browser pe swypik.com)
  ↓
git commit + git push origin task/<nume>
  ↓
merge in main pe GitHub (PR)
  ↓
deploy.sh idempotent (pull + migrate + build + restart)
```

**Reguli stricte**:
- VPS = sursa de adevar pentru cod live
- GitHub = mirror/backup + history + colaborare
- **Zero editare locala pe Windows** (CRLF / path-uri win)
- Fiecare task = un branch, un PR, smoke test inainte de merge
- DB backup `pg_dump` INAINTE de orice migration
- Pre-commit hook: lint + typecheck (in Faza G adaugat)

---

## 4. STRUCTURA TINTA (folder layout final)

```
/opt/swypik/app/
├── app/                                    # Next.js App Router (mobile-first)
│   ├── (marketing)/                        # /, /about, /pricing, /creators
│   ├── (feed)/                             # / (For You), /following, /trending, /shop, /local
│   ├── (live)/                             # /live, /live/[id], /live/watchparty/[id]
│   ├── (adult)/                            # /18, /18/feed, /18/creators (age-gated)
│   ├── (shop)/                             # /product/[id], /collections, /search, /category/[slug],
│   │                                       #   /drops, /drops/[id], /bundles, /wishlist/[token]
│   ├── (account)/                          # /onboarding, /profile, /orders, /wallet, /streak,
│   │                                       #   /age-verify, /squad, /loyalty, /reorder
│   ├── (creator)/                          # /creator/dashboard, /creator/upload, /creator/record,
│   │                                       #   /creator/live, /creator/paid, /creator/videos,
│   │                                       #   /creator/earnings, /creator/affiliate, /creator/services,
│   │                                       #   /creator/duet/[id]
│   ├── (seller)/                           # /seller/dashboard, /seller/products, /seller/orders,
│   │                                       #   /seller/drops, /seller/groupbuy, /seller/support
│   ├── (admin)/                            # /admin/* (dashboard, marketplace, fulfillment,
│   │                                       #   moderation, challenges, age-verify, live-mod, drops)
│   ├── communities/                        # /communities, /communities/[slug] (Discord-style)
│   ├── inbox/                              # bottom nav target: notif + AI chat + DM later
│   └── api/
│       ├── auth/                           # login, signup, magic-link, session, age-verify
│       ├── feed/                           # for-you, following, trending, shop, local, recommendations
│       ├── events/                         # tracking (watch_time, skip, like, save, etc)
│       ├── products/                       # CRUD + search (cu flags is_adult, is_drop, is_bundle)
│       ├── drops/                          # NEW: list, create, waitlist, claim
│       ├── groupbuy/                       # NEW: create group, join, status, payout
│       ├── bundles/                        # NEW: AI bundle suggest, checkout
│       ├── wishlist/                       # NEW: list, add, share token, public view
│       ├── reorder/                        # NEW: history → one-tap reorder
│       ├── checkout/                       # Stripe Checkout + BNPL (Klarna)
│       ├── orders/
│       ├── upload/                         # video/image presigned URLs
│       ├── creator/                        # upload-session, AI hooks, captions, library, paid,
│       │                                   #   subs, affiliate, collabs, services, duet, stitch
│       ├── seller/
│       ├── ai/
│       │   ├── hooks/                      # creator hook suggest
│       │   ├── caption/                    # creator caption suggest
│       │   ├── summarize-comments/         # AI summary
│       │   ├── chat/                       # AI assistant chat (SSE streaming)
│       │   ├── stylist/                    # NEW: outfit composer
│       │   ├── gift-finder/                # NEW: gift recommendation
│       │   ├── review-script/              # NEW: AI scrie review pentru tine
│       │   ├── translate/                  # NEW: ElevenLabs voice clone + subtitle
│       │   ├── explain-video/              # NEW: AI explica clipul tehnic
│       │   ├── visual-search/              # NEW: upload poza → CLIP embeddings → produse similare
│       │   └── voice-command/              # NEW: voice → action
│       ├── live/                           # start, stop, join, tips, gifts, viewers, replay
│       ├── tips/                           # send tip, payout to creator (instant)
│       ├── subscriptions/                  # creator paid content subs
│       ├── challenges/
│       ├── rewards/                        # wallet, history, claim, spin, mystery box
│       ├── streaks/                        # NEW: combo streaks (action-based)
│       ├── collections/
│       ├── communities/                    # NEW: list, create, join, feed, chat
│       ├── squad/                          # NEW: invite friends, friend feed, leaderboard
│       ├── watchparty/                     # NEW: sync watch sessions
│       ├── loyalty/                        # NEW: tier calc, perks, progress
│       ├── ar/                             # NEW: AR try-on token (WebXR / Snap Camera Kit)
│       ├── notifications/                  # personalized push (cand activam push)
│       └── webhooks/                       # stripe, supplier, r2, livestream, klarna
├── components/
│   ├── nav/                                # BottomNav (mobile fix), TopBar, SideNav (desktop)
│   ├── feed/                               # FeedPlayer, VideoCard, ActionBar, ProductChip,
│   │                                       #   AdultBlur, DropCountdown, GroupBuyBadge,
│   │                                       #   ResumeSwipeBanner, TrendChip, SocialProofBadge
│   ├── live/                               # LivePlayer, ChatPanel, TipButton, GiftPicker,
│   │                                       #   ViewerCount, FanBadge, AddToCartLive, BuyersFeed
│   ├── creator/                            # UploadFlow, RecordCamera, HookSuggest, CaptionEditor,
│   │                                       #   LiveStudio, PaidPaywall, AffiliatePicker, CollabInvite,
│   │                                       #   ServicesEditor, DuetRecorder, StitchEditor
│   ├── shop/                               # ProductCard, AddToCart, SocialProof, BundleSuggest,
│   │                                       #   BNPLBadge, ARTryOnButton, VisualSearchSheet,
│   │                                       #   ReorderTile, WishlistShareSheet, LiveSupportButton
│   ├── ai-chat/                            # ChatBubble, ChatPanel (streaming), VoiceInputButton
│   ├── ai/                                 # StylistSheet, GiftFinderSheet, ReviewScriptModal,
│   │                                       #   TranslateToggle, ExplainClipSheet
│   ├── adult/                              # AgeGate, AdultWarning, PaywallSheet
│   ├── community/                          # CommunityCard, CommunityFeed, CommunityChat
│   ├── social/                             # SquadInvite, FriendLeaderboard, WatchPartySync
│   ├── gamify/                             # SpinWheel, MysteryBox, StreakCounter, LoyaltyTier,
│   │                                       #   EasterEggHunt, BadgeShowcase
│   ├── ui/                                 # primitives (Button, Modal, Sheet, Toast, Haptic wrapper)
│   ├── motion/                             # Framer Motion presets (60fps animations)
│   └── shared/                             # Header, Footer, Onboarding, ThemeProvider (dark default)
├── lib/
│   ├── auth/                               # UN sistem unificat (Faza F)
│   ├── db/
│   │   ├── schema.ts                       # Drizzle
│   │   └── queries/                        # per-entity (feed, products, orders, drops, etc)
│   ├── feed/                               # candidate generation + ranking + cache
│   ├── ai/                                 # OpenAI / ElevenLabs / Snap Camera SDK wrappers
│   ├── storage/                            # R2 client + signed URLs
│   ├── stripe/                             # Stripe + Klarna BNPL
│   ├── live/                               # Cloudflare Stream Live client
│   ├── ar/                                 # WebXR helpers / Snap Camera Kit init
│   ├── visual-search/                      # CLIP embeddings via OpenAI / Replicate
│   ├── haptic/                             # navigator.vibrate wrappers
│   ├── feature-flags.ts                    # exista
│   ├── logger.ts                           # exista, propaga
│   └── analytics/                          # event tracker (batch + sendBeacon)
├── workers/
│   ├── video/                              # Python FFmpeg
│   ├── ai/                                 # background AI tasks (hooks, captions, embeddings,
│   │                                       #   translate, voice clone)
│   ├── ranking/                            # precompute feed cache
│   ├── drops/                              # NEW: countdown ticker, waitlist notify, sold-out trigger
│   ├── groupbuy/                           # NEW: poll group, trigger discount, refund failed
│   ├── notifications/                      # personalized push generator
│   └── streaks/                            # NEW: daily reset, combo calc, reward dispatch
├── infra/
│   └── hetzner/                            # docker-compose.prod.yml, Caddyfile, deploy.sh
├── migrations/                             # Drizzle SQL, numerotate strict
├── tests/
│   ├── e2e/                                # Playwright: feed, checkout, upload, live, paid, drops
│   └── unit/                               # ranking score, event tracker, bundle algo
└── CLAUDE.md                               # SINCRONIZAT cu realitatea
```

---

## 5. ROADMAP PE FAZE (cu toate cele 40 idei integrate)

### FAZA A — Curatenie + Audit functional (1-2 zile, secvential)
**Goal**: stim exact ce merge si ce nu, fara junk.

- A1. Push `mvp-freeze` la GitHub ✅ DONE
- A2. Cleanup junk files ✅ DONE (16 fisiere sterse, 3.4MB)
- A3. **Audit functional end-to-end** pentru fiecare flux MVP: onboarding nou user, For You feed, Save→Collections, More like this/Not interested, Creator upload, Add to cart→Checkout→Stripe, Daily challenge, Wallet SWYP, Social proof. Output = matrix ✅/⚠️/❌.
- A4. Sync `CLAUDE.md` cu structura reala (`/opt/swypik/app`, Go folosit, frozen modules, workflow nou)

---

### FAZA B — UI MVP "calumea" + Bottom Nav + Mobile-first (5-7 zile, agent 1)
**Goal**: feed-ul + actiunile arata si se simt TikTok-grade pe mobil.

- B1. **For You feed redesign** (`app/(feed)/page.tsx`) — full-screen vertical, snap scroll, autoplay mute, preload N+1/N+2, action bar dreapta, product chip jos, creator info stanga jos, tabs Following/For You/Trending/Shop/Local, primul clip <2s, zero loading spinner
- B2. **Onboarding rapid** — 1 ecran cu 12-15 chipuri interese (Funny, AI, Gadget, Beauty, Fitness, Deals, Crypto, Fashion, Food, Gaming, Home, Educatie, Local, Business), min 3 select → start, skip option
- B3. **Save → Collections bottom sheet** — tap Save → sheet cu colectii + quick create + toast
- B4. **Wallet + Streak widget** in header (SWYP count + flame counter)
- B5. **Social proof badges** (#10) — "12.4k views · 83 saves", "Top in AI today", "43 cumparari · 4.7★"
- B6. **Bottom nav TikTok-style** (`components/nav/BottomNav.tsx`) — fix bottom mobile: Feed | Discover | **Upload (+)** big center | Inbox | Profile + tap "+" modal: Record / Upload / Go Live + haptic feedback (#37) + safe-area-inset-bottom
- B7. **Resume swipe banner** (#9) — la return: "Ai vazut 23 clipuri ieri, continua de unde ai ramas"
- B8. **Mobile-first audit pass complet** (#7) — fix tap targets <44px, scroll issues, sticky headers, safe areas, swipe gestures, pull-to-refresh, pinch-zoom imagini, viewport `dvh` units (iOS Safari)
- B9. **Dark mode default** (#39) — ThemeProvider cu dark first, light optional in settings
- B10. **Smooth animations 60fps** (#38) — Framer Motion presets pe tranzitii feed, tap, sheet open
- B11. **Haptic feedback** (#37) — `navigator.vibrate` pe save/like/buy success, abstract in `lib/haptic/`
- B12. **PWA manifest + service worker basic** — install prompt mobile, offline shell

---

### FAZA C — Event tracking + Ranking real (2-3 zile, agent 2)
**Goal**: feed-ul reactioneaza la comportament in 5-10 clipuri.

- C1. **Event collector** (`app/api/events/route.ts`) — POST batch evenimente in `feed_events`. Tipuri: video_view, watch_time, completion, rewatch, skip_fast, pause, like, save, share, comment, follow, product_click, add_to_cart, purchase, not_interested, more_like_this, report
- C2. **Client tracker** (`lib/analytics/tracker.ts`) — buffer in memory, flush la 5s sau 20 events, sendBeacon la close
- C3. **Ranking engine** (`lib/feed/ranking.ts`) — score = watch_time + completion + save + share + follow + product_click + add_to_cart + purchase + freshness − skip_fast − report. **Greutati commerce**: purchase > add_to_cart > save > like
- C4. **More like this / Not interested** — boost/penalty in `user_feed_state`, urmatoarele 5-10 clipuri reflecta schimbarea
- C5. **Feed cache Redis** — `feed:user:{id}` TTL 30min, invalidat la actiuni puternice

---

### FAZA D — Creator AI assist + AI Chat reactivat (3-4 zile, agent 3)
**Goal**: creatorii posteaza cu hook-uri bune, useri primesc AI util.

- D1. **AI hook suggest** (`/api/ai/hooks`) — input: video transcribe + product → output: 3 hook-uri sub 8 cuvinte, OpenAI gpt-4o-mini, cache Redis
- D2. **AI caption suggest** (`/api/ai/caption`) — caption + 5 hashtags
- D3. **AI summarize comments** (`/api/ai/summarize-comments`) — sentiment + intrebari frecvente, vizibil sub video pentru creator + user
- D4. **AI "save all tools"** — detect produse/tools mentionate in transcribe, buton "Salveaza toate" → colectie auto
- D5. **AI Chat Assistant reactivat** (`/api/ai/chat`, `components/ai-chat/ChatPanel.tsx`) — accesibil din **Inbox tab**, streaming SSE, function calling: search products, get order, save to collection, recomanda din istoric. Memory ultimele 10 turn-uri in Redis. Rate limit 30 msg/zi free, unlimited paid
- D6. **AI Stylist personal** (#28, `/api/ai/stylist`) — "Compune-mi outfit pt intalnire weekend" → 5 produse + reasoning
- D7. **AI Gift Finder** (#29, `/api/ai/gift-finder`) — "Cadou mama 50 ani gradina 200 lei" → 10 idei rankuite
- D8. **AI scrie review-ul pentru tine** (#30, `/api/ai/review-script`) — dupa primesti produs: 3 intrebari → review video script + caption
- D9. **AI auto-translate clipuri** (#31, `/api/ai/translate`) — orice clip → subtitrare + voice clone romana (ElevenLabs)
- D10. **AI "explica clipul"** (#32, `/api/ai/explain-video`) — pentru tech/educational
- D11. **Voice commands** (#40, `/api/ai/voice-command`) — "Hey Swypik, gaseste-mi cadou" → AI activat, hands-free (Web Speech API)

---

### FAZA E — Challenges + Rewards + Gamify (3-4 zile, agent 1 dupa Faza B)
**Goal**: revenire zilnica + addiction loops.

- E1. **Daily challenges** (schema deja in DB) — admin UI create + public `/challenges` + leaderboard + creator "Enter challenge" la upload
- E2. **Leaderboard** per challenge + global (top 10 today, top 100 all-time) + reward (SWYP + boost + badge)
- E3. **Daily streak** — counter zile consecutive, reward la 7 zile + push notif "Pastreaza streak-ul!"
- E4. **Wallet UI** (`/wallet`) — balance + history + tooltip "use for boost/discount"
- E5. **Spin wheel zilnic** (#4) — deschizi app dimineata → 1 spin gratuit (SWYP / discount / produs / mystery box). Variable reward = dopamine maxim
- E6. **Mystery box zilnic** (#4) — 1 box/zi continand random reward
- E7. **Streak combo** (#7) — nu doar daily login, ci streak pe **actiune**: cumpara 3 zile la rand, salveaza 5 zile, comenteaza 3 zile, share 2 zile. Bonus exponential la combo lung
- E8. **Easter eggs & secrete** (#10) — coduri ascunse in clipuri (QR / hashtag secret), badge-uri rare ("First 1000 users", "Found Easter Egg"), comunitate care vaneaza in Discord-style channel
- E9. **Loyalty tiers** (#20) — Bronze/Silver/Gold/Diamond cu progress bar pe `/loyalty`, perks: Bronze (free shipping >100 lei), Silver (early drops 1h), Gold (BNPL fara dobanda), Diamond (livrare express + concierge AI)
- E10. **Push notification psychology** (#8) — cand activam push, mesaje personalizate: "{creator_pe_care_l_urmaresti} tocmai a postat ceva ce ai salva sigur" (din interese), nu generic. Worker `notifications/` ruleaza la activitate creator + match interese user

---

### FAZA F — Shop modern + Drops + Group Buy + BNPL (5-7 zile, agent 2 dupa C)
**Goal**: magazin TikTok-Shop / Pinduoduo level.

- F1. **Drops cu countdown** (#1) — schema noua `drops` (product_id, start_at, end_at, stock_total, stock_left, waitlist_count). UI `/drops` + `/drops/[id]` cu timer live + waitlist button + push "5 min ramase"
- F2. **Worker drops** — countdown ticker (Redis TTL), waitlist notify la T-5min, sold-out trigger, auto-archive
- F3. **Group buy / co-purchase** (#3) — schema `groupbuy_sessions` (product_id, target_count, current_count, price_normal, price_group, expires_at). UI: "Inca 3 oameni si pretul scade la 79 lei", share link, refund daca nu se completeaza
- F4. **Worker groupbuy** — poll, trigger discount cand atingem target, refund failed
- F5. **Bundle smart** (#13) — AI suggest "Cumpara cu" pe pagina produs, discount 10% pe bundle. Algo: co-purchase frequency + categorie + AI semantic
- F6. **BNPL** (#16) — Stripe Klarna integration in checkout pentru cosuri >100 lei. UI badge "Plateste in 4 rate fara dobanda"
- F7. **Augmented product cards** (#17) — tap pe product chip in feed → expand sheet cu 360° view + spec + review video integrat, fara sa parasesti feed-ul
- F8. **Reorder one-tap** (#18) — `/reorder` cu istoric → "Cumpara din nou" tap. Push lunar "Esti pe terminate? Reordon-ti X"
- F9. **Wishlist public/shareable** (#15) — `/wishlist` + share token → public view `/wishlist/[token]`. "Lista mea de cadouri", cineva drag iti cumpara surpriza
- F10. **Reviews video** (#14) — useri filmeaza review 15s in app → urca → devine continut in feed (tagged "review") + social proof pe product page
- F11. **Live customer support video** (#19) — buton "Vorbeste cu vanzatorul" pe produse >300 lei → call video real-time cu seller (WebRTC), conversie +40%

---

### FAZA G — Adult vault + Paid creator content + Stripe Connect partial (5-7 zile)
**Goal**: monetizare creator + segregare 18+.

- G1. **Schema adult**: `is_adult BOOLEAN` pe `videos`, `marketplace_products`, `creator_videos`. Filter default exclude din feed normal
- G2. **Age verification hibrid** — viewers 18+: self-attest (DOB + checkbox + region + geo-block via Cloudflare WAF). Creators paid 18+: ID upload obligatoriu (Stripe Identity, ~$1.50/verify)
- G3. **Tab `/18`** — accesibil doar dupa age verify + setting toggle in `/profile`. Blur preview pentru clipuri/produse adult cand not verified ("Verify age to view")
- G4. **Geo-blocking** — Cloudflare WAF rule pentru tari unde 18+ ilegal
- G5. **Admin moderation queue** pentru content 18+ + age-verify queue
- G6. **Creator paid content schema**: `creator_subscription_plans` (price, currency, period), `user_subscriptions` (status, expires_at, stripe_sub_id), `paid_content` (video/live, price_one_time), `paid_content_purchases`
- G7. **Modele monetizare**: subscription lunar (9.99 lei), pay-per-video (4.99 lei), pay-per-live (14.99 lei), tips (FAZA J live)
- G8. **Paywall UI** (`components/adult/PaywallSheet.tsx`) — pe video paid: blur + "Unlock for X lei" / "Subscribe to {creator}" → Stripe Checkout modal → unlock instant
- G9. **Creator dashboard `/creator/paid`** — set price, view subscribers, revenue chart
- G10. **Stripe Connect partial reactivare** — DOAR pentru creators paid (subs + tips), KYC mandatory via Stripe Identity. Sellers Stripe Connect ramane frozen pana Faza I
- G11. **Subscriber-only feed** (#24) — `/creator/[id]/subs` accesibil doar pentru subscribers, content early access (chiar non-18+)
- G12. **Affiliate links instant** (#21) — orice creator atasaza orice produs la clip cu un tap → 10-15% comision automat la vanzare. Trackable in `/creator/affiliate`
- G13. **Creator collabs** (#22) — 2 creatori posteaza impreuna, split revenue automat (50/50 default, configurable)
- G14. **Creator marketplace de servicii** (#26) — `/creator/services`: consultatii (call video 30min), shoutout-uri, request-uri custom video. Stripe payment, payout via Connect
- G15. **Tips cu mesaj public** (#25) — "Maria a trimis 50 SWYP: 'iubesc continutul tau!'" → vizibil in chat live + comments video. Social proof pentru alti tippers

---

### FAZA H — Communities + Social + Local feed (4-5 zile, agent 3 dupa D)
**Goal**: retention long-term + network effect.

- H1. **Comunitati / grupuri tematice** (#33) — `/communities` cu grupuri ("AI Tools RO", "Skincare addicts", "Crypto degens"). Fiecare are: feed propriu, challenges, top creators, chat (Redis pub/sub + SSE). Hibrid Discord + TikTok
- H2. **Squad / friend feed** (#34) — `/squad`: invite prieteni → vezi ce salveaza, leaderboard intre prieteni, "Maria a salvat 12 clipuri azi"
- H3. **Watch parties** (#35) — sincronizat: 5 prieteni se uita simultan la acelasi feed/live cu chat side panel. Folosit pentru drops mari sau live shopping
- H4. **Local feed** (#36) — `/local`: clipuri/produse din orasul tau (geo-IP + opt-in location). Discover local sellers + creators. Push: "5 oferte noi in Bucuresti azi"
- H5. **Trends discovery** (#6) — `/trending` cu sound/sticker/effect trending: "Folosit de 12k creatori azi". Tap → folosesti tu in upload. Loop viral
- H6. **Dueturi / Stitch / Reactii** (#5) — buton pe video: "Duet" (split screen) / "Stitch" (taie 5s + raspunde) / "React" (clip overlay reaction). Editor in `/creator/duet/[id]`. Creeaza chains de continut

---

### FAZA I — Visual search + AR try-on + Voice (4-5 zile)
**Goal**: experiente moderne tech-forward.

- I1. **Visual search** (#12) — `/api/ai/visual-search`: upload poza → CLIP embeddings (OpenAI / Replicate) → top 20 produse similare in catalog. UI: camera capture + photo upload sheet
- I2. **AR try-on** (#11) — `/components/shop/ARTryOnButton.tsx`: WebXR pentru ochelari + ruj + ceasuri (geometric simple). Snap Camera Kit pentru fashion mai complex (lipstick, makeup). Decisive pentru beauty/fashion conversion
- I3. **Fan badges in chat live** (#23) — top tipper / abonat 6 luni → badge colorat in chat live + comments. Status social, motiveaza tipping

---

### FAZA J — Live streaming complet (4-5 zile, ULTIMUL feature mare)
**Goal**: live shopping + tips real-time. Cea mai complexa faza, dar build pe tot ce am facut.

- J1. **Tech**: Cloudflare Stream Live (cel mai aproape de TikTok stack: edge RTMP ingest + LL-HLS + CDN global, ~$1/1000 min). Alternative: Mux ($0.04/min mai scump dar matur), LiveKit self-hosted (control total + zero cost/min, dar trebuie SFU server +10€/luna)
- J2. **Creator flow**: `/creator/live` → preview camera → start → push stream key Cloudflare. Schema `live_streams` (id, creator_id, status, started_at, viewer_count, title, is_adult, is_paid)
- J3. **Viewer flow**: `/live/[id]` → HLS.js / native HLS player → low-latency. Skeleton zero pana frame 1
- J4. **Live chat real-time**: Redis pub/sub + SSE → mesaje real-time. Tabel `live_chat_messages` (Postgres pentru log, Redis pentru hot path)
- J5. **Tips/Gifts** (#2) — buton heart in chat → modal "Trimite gift" cu preset (1, 5, 10, 50 SWYP / lei) → Stripe payment intent → 80% creator / 20% platform → instant notif + animatie pe stream (heart explosion)
- J6. **Add to cart in stream** (#2) — produs atasat clickabil DURING live → AddToCart modal fara sa parasesti. "47 oameni au cumparat acum" floating ticker, FOMO
- J7. **Buyers feed live** — ticker scroll cu "X tocmai a cumparat", "Y a trimis 50 SWYP"
- J8. **Reactions floating** — hearts/emoji pop animations, real-time
- J9. **Live replay** — end live → save in R2 daca creator vrea. Apare ca video normal in feed, cu tag "Live replay"
- J10. **Geo-block + adult flags** — live can fi 18+ paid (combina G + J)

---

### FAZA K — Auth unification (1 zi, izolat in PR)
**Goal**: un singur model de account.

- Tabel nou `accounts` cu `role: customer|seller|creator|admin`
- Migration: copy din `users` + `customers` + `sellers` + `auth_accounts` + `creators`
- Update `lib/auth/` + toate route handlers (~60 fisiere)
- Tabele vechi raman 1 saptamana (read-only) ca fallback
- Test login pentru fiecare rol
- **Risk mare** — facem dupa Faza A-J sunt stabile in productie

---

### FAZA L — Code quality continuu (in paralel cu toate)
- Inlocuieste 286 `console.log` cu `lib/logger.ts`
- Reduce 297 `: any` (typecheck strict pe fisiere noi)
- Renumeroteaza migrari ambigue `20260513_0008_*`
- Porturi 18789/18790 inchise (gateway AI eliminat 2026-07-23)
- E2E tests Playwright: onboarding, feed, save, checkout, upload, live, paid, drops, groupbuy
- Pre-commit hooks (lint + typecheck + format)

---

### FAZA M — Stabilizare (cand traficul o cere, trigger >100 users/zi)
- Sentry (error tracking)
- Grafana + Prometheus (API latency, queue size, video processing time, live concurrent)
- Health endpoints: `/api/health/{db,redis,r2,queue,live}`
- Backup automat DB daily + weekly
- Failed job retry dashboard
- Uptime monitor extern (BetterStack)

---

### FAZA N — Growth (>1k users/zi)
- Separare workers pe servere dedicate (video, AI, cron, fulfillment, notifications)
- Postgres read replica
- Redis cluster sau Redis dedicated
- Load balancer Hetzner + 2 app servers Next.js
- Stripe Connect full reactivare (sellers payout)

---

### FAZA O — TikTok-level (>10k users/zi)
- Multi-region read (EU + US edge cache)
- Search engine (Meilisearch / OpenSearch) pentru produse + creators + clipuri
- Analytics warehouse (ClickHouse) pentru event pipeline
- Dedicated encoding farm
- A/B testing framework
- Anti-fraud + moderation pipeline real (ML, nu doar manual)
- AI clone voice/avatar (#27, controversial dar trendy) — creator antreneaza AI pe vocea/look, fanii interactioneaza cu "AI version"

---

## 6. ORDINE EXECUTIE (cu agenti paraleli unde se poate)

```
A.  Audit functional                    [1-2 zile, secvential]
    ↓
B.  UI MVP + Bottom nav + Mobile-first  [5-7 zile, agent 1]
C.  Event tracking + Ranking            [2-3 zile, agent 2]    ┐ paralel
D.  Creator AI + AI Chat                [3-4 zile, agent 3]    ┘
    ↓
E.  Challenges + Rewards + Gamify       [3-4 zile, agent 1]    ┐
F.  Shop modern + Drops + GroupBuy      [5-7 zile, agent 2]    ├ paralel
G.  Adult + Paid + Stripe Connect       [5-7 zile, agent 3]    ┘
    ↓
H.  Communities + Squad + Local         [4-5 zile, agent 1]    ┐
I.  Visual search + AR + Voice          [4-5 zile, agent 2]    ┘ paralel
    ↓
J.  LIVE STREAMING (ultimul)            [4-5 zile]
    ↓
K.  Auth unification                    [1 zi, izolat PR]
    ↓
L.  Code quality + E2E tests            [continuu]
    ↓
M-O. Stabilizare → Growth → TikTok-level [cand traficul cere]
```

**Total estimat MVP complet (Faza A-K)**: ~50-60 zile cu 3 agenti paraleli, sau ~100-120 zile solo.

---

## 7. CE LIPSESTE DIN COD AZI (priority list complet)

| # | Lipsa | Faza | Ore est |
|---|---|---|---|
| 1 | Audit functional matrix | A | 4h |
| 2 | Sync CLAUDE.md | A | 1h |
| 3 | For You feed redesign full-screen | B | 12h |
| 4 | Onboarding rapid 1-screen | B | 3h |
| 5 | Save → Collections sheet | B | 4h |
| 6 | Wallet + Streak widget header | B | 3h |
| 7 | Social proof badges | B | 3h |
| 8 | Bottom nav TikTok-style + haptic | B | 6h |
| 9 | Resume swipe banner | B | 2h |
| 10 | Mobile-first audit pass | B | 8h |
| 11 | Dark mode default | B | 2h |
| 12 | Animations 60fps Framer Motion | B | 4h |
| 13 | PWA manifest + SW | B | 3h |
| 14 | Event collector + tracker | C | 6h |
| 15 | Ranking engine commerce-weighted | C | 8h |
| 16 | More like this / Not interested | C | 4h |
| 17 | Feed cache Redis | C | 3h |
| 18 | AI hooks + caption + summarize | D | 12h |
| 19 | AI Chat Assistant reactivat + functions | D | 12h |
| 20 | AI Stylist | D | 4h |
| 21 | AI Gift Finder | D | 4h |
| 22 | AI Review Script | D | 4h |
| 23 | AI Translate + voice clone (ElevenLabs) | D | 8h |
| 24 | AI Explain video | D | 3h |
| 25 | Voice commands | D | 4h |
| 26 | Daily challenges UI + leaderboard | E | 6h |
| 27 | Streak counter daily | E | 3h |
| 28 | Wallet UI + history | E | 4h |
| 29 | Spin wheel + mystery box | E | 6h |
| 30 | Streak combo (action-based) | E | 4h |
| 31 | Easter eggs + badge system | E | 6h |
| 32 | Loyalty tiers + perks | E | 6h |
| 33 | Push notif psychology personalizat | E | 6h |
| 34 | Drops countdown + waitlist + worker | F | 10h |
| 35 | Group buy + worker | F | 8h |
| 36 | Bundle smart AI | F | 6h |
| 37 | BNPL Klarna integration | F | 4h |
| 38 | Augmented product cards expand | F | 4h |
| 39 | Reorder one-tap | F | 3h |
| 40 | Wishlist public shareable | F | 4h |
| 41 | Reviews video in-app | F | 6h |
| 42 | Live customer support video | F | 8h |
| 43 | Adult schema + filter + tab /18 | G | 8h |
| 44 | Age verify hibrid (self + ID) | G | 6h |
| 45 | Geo-blocking adult Cloudflare | G | 2h |
| 46 | Admin moderation 18+ + queue | G | 6h |
| 47 | Paid content schema + paywall UI | G | 12h |
| 48 | Stripe Connect partial (creators) | G | 8h |
| 49 | KYC creator (Stripe Identity) | G | 4h |
| 50 | Subscriber-only feed | G | 4h |
| 51 | Affiliate links instant + dashboard | G | 8h |
| 52 | Creator collabs split revenue | G | 6h |
| 53 | Creator services marketplace | G | 8h |
| 54 | Tips public message | G | 3h |
| 55 | Communities tematice | H | 12h |
| 56 | Squad / friend feed | H | 6h |
| 57 | Watch parties sync | H | 8h |
| 58 | Local feed geo | H | 4h |
| 59 | Trends discovery sound/sticker | H | 6h |
| 60 | Dueturi / Stitch / Reactii editor | H | 12h |
| 61 | Visual search CLIP | I | 8h |
| 62 | AR try-on WebXR / Snap Kit | I | 16h |
| 63 | Fan badges live chat | I | 3h |
| 64 | Live streaming Cloudflare Stream | J | 16h |
| 65 | Live chat Redis SSE | J | 6h |
| 66 | Tips/gifts during live + animations | J | 6h |
| 67 | Add to cart in stream + buyers ticker | J | 6h |
| 68 | Reactions floating + replay | J | 4h |
| 69 | Auth unification | K | 8h |
| 70 | E2E Playwright complet | L | 16h |

**Total estimat: ~430 ore (~11 saptamani solo, ~4-5 saptamani cu 3 agenti paraleli).**

---

## 8. DECIZII CONFIRMATE (sesiune 2026-05-13)

- **Live tech**: Cloudflare Stream Live (cel mai aproape de TikTok stack), implementat ULTIMUL (Faza J)
- **Age verification**: Hybrid — self-attest viewers, ID upload (Stripe Identity) creators paid 18+
- **Executie**: Hybrid — Faza A secvential, apoi B-G cu 3-4 agenti paraleli, K+L izolat
- **Workflow**: edit pe VPS, push GitHub mirror, deploy.sh idempotent
- **Go platform-api**: PASTREAZA (folosit activ de creator video upload + ranking + proxy social)
- **Mobile-first**: OBLIGATORIU pe orice pagina/componenta noua
- **Dark mode**: default
- **40 idei moderne**: TOATE incluse, distribuite in fazele potrivite

---

## 9. DECIZII INCA DESCHISE (am nevoie de tine)

1. **AI provider principal**: OpenAI gpt-4o-mini ($0.15/M tokens) vs Anthropic Claude Haiku ($0.25/M) vs Mistral local? Default: OpenAI.
2. **Voice clone provider**: ElevenLabs ($5-22/luna) vs Cartesia vs OpenAI TTS? Default: ElevenLabs (calitate romana cea mai buna).
3. **AR Try-on stack**: WebXR pure (free, limitat) vs Snap Camera Kit (gratis pentru web, polished) vs Banuba (paid, polished)? Default: Snap Camera Kit.
4. **Visual search embeddings**: OpenAI CLIP via Replicate ($) vs self-host CLIP pe Hetzner (free, GPU needed)? Default: Replicate pentru MVP, self-host in Faza N.
5. **Push notifications reactivare**: cand? Default: Faza E (challenges + streak + drops au cel mai mult sens cu push).
6. **DM reactivare**: cand? Default: Faza H (cu Communities, scope hibrid: DM + community chat).
7. **Stripe Connect sellers full**: cand? Default: Faza N (Growth).
8. **Adult vault accept**: doar 18+ explicit sau si "spicy/suggestive" (lingerie, fitness shirtless)? Default: explicit only.
9. **Paid content split**: 80/20 default. Negociabil top creators (90/10 dupa 10k subs)?
10. **BNPL provider**: Klarna only sau si Afterpay/Affirm? Default: Klarna only (acoperire EU buna).

---

## 10. ACCEPTANCE CRITERIA ("MVP complet done")

```
✅ User nou deschide swypik.com → vede feed in <3s, fara cont
✅ Onboarding 1 ecran, 3+ interese, intra direct in feed
✅ Swipe vertical fluid, video N+1 preloaded, zero loading spinner
✅ Tap Save → bottom sheet → salveaza in colectie → toast
✅ Tap More like this → urmatoarele 5 clipuri reflecta categoria
✅ Tap Not interested → categoria scade
✅ Tap Follow → creator apare in tab Following
✅ Tap Add to cart → Checkout → Stripe → comanda → email
✅ Creator upload video → AI 3 hook-uri → publish → in feed
✅ Daily challenge vizibil → enter → leaderboard updated
✅ SWYP Points cresc cu actiuni → vizibile in /wallet
✅ Streak counter creste daily → reward 7 zile
✅ Social proof vizibil pe fiecare video (views, saves, buys)
✅ Bottom nav mobile: Feed/Discover/Upload(+)/Inbox/Profile functional iOS+Android
✅ In-app camera record functioneaza (60s + preview + publish)
✅ Drops countdown live + waitlist functional
✅ Group buy: target atins → discount aplicat tuturor
✅ Spin wheel daily + mystery box
✅ BNPL Klarna in checkout >100 lei
✅ Reorder one-tap din /reorder
✅ Wishlist shareable public link
✅ Reviews video in feed cu tag "review"
✅ Live customer support video pe produse >300 lei
✅ Adult vault: feed normal exclude is_adult, /18 doar dupa age verify, geo-block functional
✅ Paid creator content: subscribe, paywall, unlock dupa Stripe
✅ Affiliate links: creator atasaza orice produs → comision 10-15% trackable
✅ Creator collabs split revenue automat
✅ Creator services marketplace functional
✅ Tips public message in chat live + comments
✅ AI Chat Assistant: deschis din Inbox, streaming, recomanda + actiuni
✅ AI Stylist + Gift Finder + Review Script + Translate + Explain Video
✅ Voice commands "Hey Swypik..." functional
✅ Communities: 3+ active, feed propriu, chat, challenges
✅ Squad: invite prieteni → friend feed → leaderboard
✅ Watch parties: 5 prieteni sync watching
✅ Local feed: orasul tau cu produse + creators
✅ Trends discovery cu sound/sticker leaderboard
✅ Dueturi/Stitch/Reactii editor functional
✅ Visual search: upload poza → produse similare
✅ AR try-on: ochelari + ruj functional pe mobile
✅ Fan badges live chat
✅ LIVE STREAMING: creator porneste, viewer vede HLS, chat real-time, tips cu animatii, add-to-cart in stream
✅ Mobile-first: zero horizontal scroll iPhone SE, tap targets 44px+, PWA installabil
✅ Dark mode default, animations 60fps, haptic feedback strategic
✅ Toate frozen modules raman 410 EXCEPT: ai-chat (D5), stripe-connect (G10 partial)
```

---

## 11. NEXT STEP CONCRET

Dupa aprobare:
1. **Faza A3** (audit functional) — lansez 3 agenti paraleli care testeaza fiecare flux MVP pe productie si returneaza matrix ✅/⚠️/❌
2. **Faza A4** (sync CLAUDE.md) — actualizez documentatia cu structura reala
3. Dupa A done, lansez **B+C+D in paralel** (3 agenti, 3 branch-uri disjuncte)

Dupa fiecare faza majora: smoke test live + commit + push + raport scurt cu ce s-a schimbat.
