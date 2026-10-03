# Raport testare E2E Swypik — QA read-only

Data: 02.08.2026 · Mediu: producție locală `http://127.0.0.1:3005` (container `swypik-prod-web-next-1`), DB `swypik_prod` @127.0.0.1:5433 (doar SELECT pentru verificări; scrierile s-au făcut exclusiv prin UI/API cu conturi `*@swypik.test`).
Unelte: Playwright (Chromium headless, viewport mobil 390×844 + desktop pentru admin). Scripturi: `docs/qa/e2e/*.py`. Evidence: 125 screenshot-uri în `docs/qa/evidence/P0..P7/` + jurnale `_journal.json`.

## Rezumat pe personaje

| Persona | Flux | Verdict |
|---|---|---|
| P0 Vizitator | Home, explore, feed public, i18n, 404 | ✅ funcțional (erori consolă minore, vezi P0) |
| P1 Creator | Signup OTP, upload video (mp4/mov/fals) | ⚠️ upload-urile rămân `uploading`/`failed` — procesarea nu finalizează |
| P2 Viewer | Like/unlike, race x5, follow, profil public | ✅ like/follow OK · ❌ comentariul din UI nu ajunge în DB |
| P3 Seller | Login seller OTP | ❌ BLOCANT local: OTP doar pe email real (`app/api/seller/auth/route.ts:83-84`) |
| P4 Cumpărător | Coș → checkout | ⚠️ checkout se deschide, sumar corect, dar apare „Internal error” în pagină |
| P5 Merchant Food | `/ro/food/aplica` → aprobare `/admin/aplicatii` | ✅ end-to-end PASS (pending → active) |
| P6 Șofer/Curier | `/ro/join/fleet` → aprobare `/admin/fleet` → PWA `/courier` | ✅ end-to-end PASS (aprobare a necesitat accept dialog confirm) |
| P7 Admin | Dashboard, moderare | ⚠️ dashboard OK · ❌ clipul QA nu apare în `/admin/moderation` |

## Constatări detaliate

### P1 — Upload video (⚠️)
- Toate cele 3 upload-uri (mp4 portrait 15s, .mov, fișier fals .mp4) au afișat „procesare” dar în DB rândurile rămân `uploading` sau trec în `failed` — inclusiv fișierul valid. Fișierul fals NU e respins la validare (ajunge în pipeline și eșuează târziu).
- Recomandare: validare MIME/probe la upload + feedback de eroare în UI (utilizatorul nu află că a eșuat).

### P2 — Interacțiuni sociale
- Like: 0→1, unlike 1→0, 5 click-uri rapide → final consistent 1. ✅ idempotent.
- Comentariu: trimis din UI, DB rămâne 0→0. ❌ Cauza probabilă: bottom-nav (`components/BottomNav.tsx:41`, `fixed z-30`) interceptează click-ul pe „Trimite comentariul” din CommentsSheet la 390×844 (detalii în `EXPLORE_REDESIGN_SPEC.md`, bug 3a).
- Follow: contorizat corect în DB. Profil public consistent între creator/viewer/incognito (1 CLIP).

### P3 — Seller (❌ blocant de testare)
- OTP-ul de seller se trimite doar pe email real; nu e recuperabil în mediul de test (log doar în dev). Fluxul post-login nu a putut fi testat E2E.

### P4 — Checkout (⚠️)
- Coș cu 3× Smart TV, subtotal 7.499,97 RON, livrare gratuită — sumar corect, checkout intern (nu redirect Stripe imediat), dar textul „Internal error” apare în pagina de checkout. De investigat API-ul de shipping/quote sau payment intent.

### P5/P6 — Onboarding parteneri (✅)
- Restaurant: aplicare publică `/ro/food/aplica` → `local_merchants` (pending) → aprobare din `/admin/aplicatii` → `active`. PASS complet.
- Curier: aplicare `/ro/join/fleet` → `couriers` (pending) → aprobare din `/admin/fleet` (butonul „Aprobă” cere `window.confirm` — primul test a eșuat până la handler de dialog) → `approved`. PWA `/courier` afișează corect starea OFFLINE + câștiguri.
- Observație: rutele „intuitive” (`/merchant`, `/become-a-driver`, `/driver` etc.) dau 404 — onboarding-ul e greu de descoperit; luați în calcul redirecturi.
- DB: 17 pricing_zones, curieri aprobați prezenți; `local_merchants` populat prin test.

### P7 — Admin
- Dashboard afișează secțiunile complete (DB real: 22 users, 26 videos, 3 comenzi).
- ❌ Clipul QA (`446ded17…`) nu apare în `/admin/moderation` — coada de moderare pare să nu listeze clipurile publicate/procesate; moderarea acelui clip nu a putut fi exercitată din UI.

## Bug-uri UX confirmate (viewport mobil 390×844)
1. Bottom-nav (z-30) interceptează click-uri pe „Trimite comentariul” (CommentsSheet) și „Salvează” din `/account/edit` — z-index/padding lipsă. Fix propus în `docs/qa/EXPLORE_REDESIGN_SPEC.md`.
2. Diacritice lipsă: „Adauga un comentariu...” (`CommentsSheet.tsx:298`) + alte stringuri hardcodate.
3. Cod vechi de vot (`VoteButtons.tsx`, `video_product_votes`) — invizibil în explore, folosit doar în `post/[slug]` și ProductDrawer.

## Livrabile
- `docs/qa/RAPORT_E2E.md` (acest fișier)
- `docs/qa/EXPLORE_REDESIGN_SPEC.md` — audit + spec redesign feed TikTok-style
- `docs/qa/e2e/*.py` — scripturi Playwright reutilizabile
- `docs/qa/evidence/` — 125 screenshot-uri + jurnale JSON (P0:18, P1:32, P2:20, P3:5, P4:13, P5:7, P6:8, P7:22)

## Top priorități recomandate
1. (P3) OTP seller recuperabil în non-prod (log/mailhog) — deblochează testarea.
2. (P2/UX) Fix z-index bottom-nav vs sheet-uri — comentariile sunt efectiv nefuncționale pe mobil.
3. (P1) Pipeline procesare video: clipuri blocate în `uploading`/`failed` fără feedback.
4. (P4) „Internal error” în checkout.
5. (P7) Coada `/admin/moderation` nu vede clipurile existente.
