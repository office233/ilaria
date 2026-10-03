# Swypik — Roadmap „Video Sells Everything"

> Viziune: singura platformă unde un clip video vinde ORICE — produs, masă, cameră, cursă —
> cu comision de creator auditabil on-chain (SWYP).
> Creat: 2026-08-01. Status: PLAN.

---

## FAZA 0 — Fundație (fără asta nimic nu ține) — ~2-3 săptămâni

### 0.1 Închiderea fluxurilor existente (din TODO.md)
- [ ] `/api/eats/` — folder gol; consolidare pe `/api/local-orders/` sau implementare reală
- [ ] Admin lipsă: `/admin/merchants`, `/admin/couriers`, `/admin/donations` (aplicațiile rămân `pending` forever)
- [ ] `/api/causes` + `/api/campaigns/manage` — lipsesc, UI-ul le referă
- [ ] Decizie verticale: **păstrăm 5 active** (Video/Feed, Shop, Food, Stays, Go) — restul (Fly, Fleet, etc.) ascunse cu flag până au flux complet
- [ ] Activare feature flag: `FEATURE_PUSH_NOTIFICATIONS=true` (esențial pt. live + comenzi)
- [ ] ⏸ AMÂNAT: `FEATURE_STRIPE_CONNECT` — necesită cont Stripe (încă nu există; suntem în lucru). Interim: payouts selleri/creatori manual sau doar în SWYP. De reluat înainte de pilotul public.

### 0.2 Date & schema
- [ ] Tabel `video_attachments` (video_id, entity_type: product|listing|merchant|ride_zone|cause, entity_id, creator_commission_bps, status)
  - generalizarea actualului video↔product într-un link polimorf
- [ ] Tabel `creator_commissions` (ledger: attachment_id, order/booking_id, amount_swyp, tx_hash on-chain, status)
- [ ] Migrare: video-urile cu produs existente → `video_attachments`

---

## FAZA 1 — Cross-sell video → servicii (diferențiatorul #1) — ~3-4 săptămâni

### 1.1 Attach în upload
- [ ] UI upload: pas „Atașează ceva" — căutare produs / cazare / restaurant / cauză
- [ ] Permisiuni: creatorul atașează orice entitate publică; owner-ul (host/merchant) își atașează propriile entități

### 1.2 Overlay în feed
- [ ] Componentă `VideoActionCard` în player: buton contextual per tip
  - product → „Cumpără" (există deja parțial)
  - listing (Stays) → „Rezervă" → `/api/stays/quote`
  - merchant (Food) → „Comandă" → flux local-orders
  - cause → „Donează"
- [ ] Deep-link cu context păstrat (video_id + attachment_id în query) pt. atribuire

### 1.3 Atribuire & comision
- [ ] La checkout/booking: dacă sesiunea are `attachment_id` → scrie `creator_commissions`
- [ ] Fereastră de atribuire: 7 zile last-click (configurabil)
- [ ] Cron `process-creator-commissions`: la finalizare comandă/sejur → awardSwyp (idempotent, `lib/swyp/rewards.ts`) + tx on-chain
- [ ] Pagina publică `/u/[user]/earnings-proof` — link Blockscout per comision (transparența = marketing)

### 1.4 Feed ranking
- [ ] Semnale noi în `lib/feed/events.ts`: `booking_started` (+8), `booking_completed` (+20), `menu_open` (+5)
- [ ] Boost video cu attachment activ în zona geografică a userului (Stays/Food sunt locale!)

---

## FAZA 2 — Live commerce pentru servicii — ~2-3 săptămâni
(MediaMTX există deja: RTMP ingest, HLS, hooks started/ended)

- [ ] Attach entități la stream (reutilizează `video_attachments` cu stream_id)
- [ ] Overlay live: „Rezervă acum -15%" cu countdown + stoc/camere rămase în timp real
- [ ] `live_offers` (stream_id, entity_id, discount_bps, qty_cap, expires_at)
- [ ] Notificare followers la live start (hook `runOnReady` există) + push
- [ ] Tips în SWYP în live (transfer P2P există: `/api/swyp/transfer`)

---

## FAZA 3 — Misiuni sponsorizate de merchanti — ~2 săptămâni
(missions + merchants + SWYP ledger există)

- [ ] Tabel `sponsored_missions` (merchant_id, budget_swyp, reward_per_completion, criteria, geo)
- [ ] Verificare completare: cod QR la locație / comandă minimă / check-in GPS
- [ ] Self-service merchant dashboard: creează misiune, plătește buget (hybrid SWYP+FIAT), vede analytics
- [ ] Take rate platformă pe buget misiune (ex. 20%)

---

## FAZA 4 — AI assistant care rezervă — ~3-4 săptămâni
(orchestrator + ShoppingSession există în `/api/chat`)

- [ ] Tools noi în orchestrator: `search_stays`, `quote_stay`, `search_food`, `estimate_ride`, `compose_cart`
- [ ] Coș compus multi-vertical (o comandă cu items din Stays + Food + Shop) — plată hibridă SWYP+FIAT
- [ ] `FEATURE_AI_CHAT_FULL=true` după testare
- [ ] Guardrails: confirmare umană obligatorie înainte de orice plată

---

## NEVOI NON-TEHNICE (paralel cu dezvoltarea)

### Legal / firmă
- [ ] SRL dedicat Swypik (dacă nu există separat de Meister)
- [ ] ToS + Privacy actualizate: comisioane creator, atribuire, misiuni sponsorizate
- [ ] Aviz juridic SWYP: poziționare ca puncte de loialitate closed-loop (NU e-money/MiCA) — critic înainte de orice pitch
- [ ] ANSPDCP/GDPR: DPIA pentru tracking feed + geolocație

### Conținut & ofertă (cold start)
- [ ] Minim 20-30 selleri/merchanti/hosts reali la lansare locală (un singur oraș pilot!)
- [ ] 5-10 creatori locali plătiți să producă primele 100 clipuri cu attach
- [ ] Seed video library (script `fetch-test-clips.sh` există pt. test; producție = conținut real)

### Metrici pentru investitori (instrumentare din ziua 1)
- [ ] Dashboard: MAU, D7/D30 retention, GMV per vertical, attach rate (%videouri cu entitate), CVR video→tranzacție, comisioane creator plătite
- [ ] Target pitch după 3-6 luni pilot: attach rate >30%, CVR >1%, GMV lunar crescător

### Fonduri (ordinea recomandată)
1. Grant PNRR / Start-Up Nation (nu diluează)
2. Accelerator: Techcelerator / Startup Wise Guys (100-200k €)
3. Angels: TechAngels / SeedBlink (după metrici pilot)
4. Seed VC: Early Game / GapMinder / Eleven (cu tracțiune pe pilot)

### Echipă minimă de scalat (după primii bani)
- [ ] 1 dev full-stack (tu nu poți fi singurul om pe prod la scale)
- [ ] 1 ops/growth local (recrutare merchanti + creatori în orașul pilot)
- [ ] Contabil + avocat (colaborare, nu angajați)

---

## ORDINE DE EXECUȚIE RECOMANDATĂ
1. Faza 0 (fundație + curățenie) → 2. Faza 1 (cross-sell = pitch-ul) → 3. pilot 1 oraș +
   metrici → 4. Faza 2 (live) → 5. Faza 3 (misiuni sponsorizate = primul venit B2B) → 6. Faza 4 (AI booking)

**Regula de aur: niciun vertical nou până când attach rate + CVR nu demonstrează bucla video→tranzacție.**
