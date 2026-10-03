# Audit Swarm Swypik - 2026-06-01

Scope: audit larg pe cod, DB, productie, infra, frontend/i18n, plati/fulfillment, AI/import/video. Au fost rulate 6 sub-agenti read-only plus validare directa pe VPS `/opt/swypik/app`.

## Status bun confirmat

- `/api/health=200`, timp ~0.18s, load normal.
- `npm run typecheck` pe VPS: PASS.
- VS Code diagnostics local: 0 errors.
- `cron_runs` ultimele 24h: 0 failures, 1310 success.
- `product_translations`: toate localele `de/en/es/fr/it/pt/ro = 139763`, duplicate slug = 0.
- `taxonomy_translations`: toate localele `109/109`.
- Stripe metadata: `stripe_legacy_pi_only=0`, `stripe_pi_mismatch=0`.
- Dropship: `processing_dropship` fara `ae_order_id` = 0, stale claim-uri = 0, pending vechi 7d = 0.
- DB: invalid indexes = 0.
- Safety false-positive verificat: `blocked_lolita_dress=0`.
- Wallet: negative coins = 0.
- Paid fraud blocked orders = 0.
- Partial orders without items = 0.
- Deploy final 2026-06-01: health, `/`, `/sitemap.xml`, a11y, forms-autocomplete si perf PASS; `post_ok=1`.

## P1 - Rezolvat in productie

1. Cron auth timing-safe inconsistent
   - Confirmat in `app/api/cron/refresh-rank/route.ts`: `provided !== expected`.
   - Confirmat in `app/api/cron/strikes-decay/route.ts`: `auth !== Bearer expected`.
   - Multe rute cron folosesc deja `timingSafeEqual`; acestea doua trebuie aduse la acelasi helper.
   - Status 2026-06-01: rezolvat cu helper `timingSafeEqual` in ambele rute si deploy validat.

2. Video safety leak in feed/public set
   - Confirmat: `ready_public_adult_or_blocked_videos=175` via `video_effective_safety`.
   - Trebuie verificat daca endpointurile publice filtreaza `video_effective_safety`; daca nu, ascuns/filtrat urgent.
   - Status 2026-06-01: rezolvat prin cleanup date, trigger DB si filtre in suprafetele publice; validare `ready_public_adult_or_blocked=0`.

3. Failed video public recurent
   - Confirmat: `failed_public_videos=1` nou.
   - Job asociat: HTTP 404 la download AE video `https://video.aliexpress-media.com/play/213250641375.mp4`.
   - Status 2026-06-01: rezolvat in watchdog/admin/video-worker si trigger DB; validare `failed_public=0`.

4. AE import post-ban still needs follow-up
   - Worker manual ruleaza si este in backoff AE pana la `2026-06-02T00:00:10Z`.
   - Guard persistent service/timer instalat pentru `2026-06-02 00:05 UTC`.
   - Ramane de verificat dupa trigger: worker sub systemd sau import finalizat; `ae_stale_running_4h` arata 1 acum, explicat de backoff-ul activ.

5. Patch-uri productie necommit-uite
   - `app/api/cron/process-dropship/route.ts`
   - `infra/hetzner/safe-deploy-web.sh`
   - `scripts/ae-bulk-import-worker.mjs`
   - `scripts/translate-products-studiai.mjs`
   - `tests/e2e/forms-autocomplete.spec.ts`
   - `db/migrations/20260601_0001_taxonomy_translations_extra_locales.sql`
   - Trebuie diff final si commit, altfel fixurile raman doar in productie/worktree.
   - Status local: workspace-ul curent nu expune `.git`; ramane de facut commit din repo-ul canonic.

## P2 - High impact, dupa P1

1. Backup/storage retention
   - `/opt/swypik/backups` = 7.7GB.
   - `marketplace_product_variants_backup_20260527` = 2.4GB.
   - Disk e OK (`39%`), dar trebuie decizie retention/drop/archive. Destructiv, necesita confirmare.

2. Logs/journal growth
   - `/var/log/journal` = 4.1GB, `/var/log` total = 6.2GB, `/opt/swypik/logs` = 43MB.
   - Status 2026-06-01: logrotate dedicat pentru `/opt/swypik/logs/*.log` instalat si validat; journal retention host ramane polish separat.

3. `.env.production` permissions
   - Confirmat `640 root:UNKNOWN /opt/swypik/app/infra/hetzner/.env.production`.
   - Status 2026-06-01: ownership/permisiuni corectate la `640 root:root`.

4. Stripe/commerce metadata debt
   - Agentul a raportat risc istoric cu mai multe chei PI; validarea actuala e curata (`legacy_only=0`, `mismatch=0`).
   - Ramane datorie de cleanup in cod: standardizare pe `stripe_payment_intent` si eventual index/coloana dedicata daca volumul creste.

5. Dropship failure alerting
   - Confirmat `dropship_failed_recent=1`, dar este manual fix-ul vechi `ae_order_response_missing_order_id_manual_fix`.
   - Nu exista alerta automata pentru item-uri care ajung `source_status='failed'`.

6. Cron alerting extern
   - DB arata 0 failures, dar nu exista dovada de alertare externa la failure streak.
   - De adaugat alerta pentru `cron_runs` failed > N in 1h.

## P3 - Frontend/i18n/UX backlog

1. Hardcoded RO ramas in UI vizibil
   - Confirmat prin grep in `app/[locale]/explore/page.tsx`, `app/[locale]/categories/[slug]/page.tsx`, `app/[locale]/about/page.tsx`, `app/[locale]/live/[id]/LiveViewerClient.tsx`, `components/CheckoutForm.tsx`, `components/ProductFeed.tsx`, `components/ChatInterface.tsx`.
   - Unele sunt metadata/SEO, altele UI direct.

2. JSON-LD unsafe consistency
   - Product page foloseste `safeJsonLd`, dar `categories`, `video`, `layout`, `seller/settings` folosesc direct `JSON.stringify` in `dangerouslySetInnerHTML`.
   - Status 2026-06-01: `categories` si `layout` uniformizate la `safeJsonLd`; scanarea nu mai gaseste `dangerouslySetInnerHTML` cu `JSON.stringify` direct in `app/`.

3. Raw `<img>` in multe pagini
   - Confirmat in cart, search, hashtag, profile, admin, seller, checkout.
   - Performance/LCP backlog: migrat treptat la `next/image` unde e potrivit.

4. Locale switch reload
   - Confirmat `window.location.reload()` in `components/i18n/LocaleQuickPicker.tsx`.
   - Status 2026-06-01: `LocaleQuickPicker` foloseste `router.refresh()`; scanarea `app/components` nu mai gaseste `window.location.reload()`.

5. External links missing `rel`
   - Confirmat cateva `target="_blank"` care trebuie verificate, in special seller returns/orders/admin tables.
   - Status 2026-06-01: linkurile gasite au `rel="noopener noreferrer"` sau au fost patch-uite.

6. A11y skip-link / landmark regression
   - Status 2026-06-01: `app/layout.tsx` are skip-link global catre `#main-content`, target SSR global, iar `/cart` are landmark `<main>`; post-deploy a11y PASS.

## P3/P4 - Infra polish

1. `cloud-init-hotplugd.service` failed
   - Singura unitate failed. Host-level, nu Swypik app.
   - Investigat sau mascat daca inutil.

2. Transient AE guard
   - Status 2026-06-01: rezolvat prin unit/timer persistent.

3. Health endpoint split
   - `/api/health` e ok acum, dar face readiness complet. Pe termen mediu: `/live` rapid si `/ready` complet.

## Suspiciuni respinse sau deja rezolvate

- Auth routes lipsa: fals pozitiv; exista `app/auth/login`, `signup`, `forgot`, `reset`.
- Stripe payment metadata corrupted: nu se confirma in DB acum.
- Product translation duplicate slug: rezolvat, duplicate = 0.
- Product translation coverage: rezolvat complet.
- Taxonomy locale gaps: rezolvat complet.
- Safety false-positive `lolita dress`: nu se confirma (`0`).
- Seller sessions unique token: schema are unique constraint; necesita doar verificare optionala de hash/cleanup.

## Next actions recomandate

1. Dupa `2026-06-02 00:05 UTC`, verifica AE post-ban guard si joburile AE.
2. Commit final pentru patch-urile deja aplicate in productie, din repo-ul canonic cu `.git`.
3. Decide retention pentru backup table 2.4GB si `/opt/swypik/backups`.
4. Adauga alerting extern pentru `cron_runs`/dropship failures.
5. Continua i18n hardcoded RO pe chat/checkout/explore/account smaller screens.
6. Migreaza treptat raw `<img>` la `next/image` unde are beneficiu real.
