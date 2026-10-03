# Audit paralel agenti Swypik - 2026-06-02

Scope: audit read-only pe securitate/API, DB/date, comert/plati, video/AI/import, frontend/i18n/SEO/a11y, infra/ops si calitate cod. Au rulat 7 agenti Explore in paralel. Validarea finala a folosit repo canonic VPS `/opt/swypik/app`, SELECT-uri read-only in Postgres si inspectie cod.

## Update remediere - 2026-06-02 E25

- Deploy val 2 verde: `/api/health=healthy`, build_time/deployed_at `2026-06-02T12:44:39Z`, `safe-deploy-web.sh` finalizat cu `post_ok=1` la `12:49:43Z`.
- Inchise din lista initiala: SEO cron timing-safe, AE API timeout, dropship paid-status/recheck, payout fraud/status hardening, feed RSS RO + safety filters, CheckoutForm `next/image` + i18n partial, backup DB automat, Docker image versioning.
- Validari: `npm run typecheck` PASS pe VPS; SQL `EXPLAIN`/rollback pentru query-uri feed/payout; health E2E 6/6, a11y 14/14, forms 10/10, perf 4/4.
- Confirmari live: `/feed.xml` are `<language>ro</language>`; imagine Docker `swypik-prod-web-next:3ebf6ee-20260602T124439Z`; `swypik-db-backup.timer` activ, urmatoarea rulare `2026-06-03 03:26:30 UTC`.
- Ramas: deciziile destructive de retention/drop backup table/journal, monitorizarea AE import `pending=1`/`running=1` non-stale, backlog i18n/raw `<img>` mai larg si teste suplimentare.

## Status productie validat

- `/api/health`: healthy, release `3ebf6ee689a3e247e1ebe84b5f469f4e328b7884`, build_time `2026-06-01T20:07:56Z`.
- Deploy final E23: health, `/`, `/sitemap.xml`, a11y, forms-autocomplete si perf PASS; `post_ok=1`.
- `cron_runs` failed 24h: `0`.
- `unsafe_public_videos`: `0`; `failed_public_videos`: `0`.
- `processed_stripe_events`: primary key prezent, duplicate event_id = `0`.
- `commerce_order_items.creator_id`: FK prezent (`commerce_order_items_creator_id_fkey`).
- AE import: `done=163763`, `skipped=12394`, `pending=1`, `running=1`, stale running 4h = `0`.
- AE post-ban guard: systemd service a rulat la `2026-06-02 00:05:01 UTC`, `status=0/SUCCESS`.
- Storage: `/opt/swypik/backups=9.0G`, `/opt/swypik/logs=44M`, `/var/log/journal=4.1G`; backup table `marketplace_product_variants_backup_20260527=2476 MB`.

## P1 - De facut primul

1. Dropship: revalidare status comanda inainte de plasarea AE
   - Fisier: `app/api/cron/process-dropship/route.ts`.
   - Observatie: claim-ul ia `source_status='pending_dropship'` si filtreaza fraud, dar nu cere explicit `co.status='paid'` si nu re-verifica statusul comenzii imediat inainte de `placeDropshipOrder()`.
   - Impact: fereastra de race intre refund/cancel webhook si cron poate plasa AE pentru un item tocmai anulat.
   - Fix recomandat: adauga `co.status='paid'` in claim query; dupa claim si inainte de AE call, re-citeste statusul comenzii si elibereaza claim-ul daca nu mai e `paid`.

2. AE API client fara timeout explicit
   - Fisier: `lib/aliexpress/client.ts`.
   - Observatie: `callAE()` foloseste `fetch(url, { method, headers, body })` fara `AbortSignal.timeout`.
   - Impact: daca API-ul AE ramane agatat, cron/worker poate sta blocat inutil.
   - Fix recomandat: `signal: AbortSignal.timeout(25000)` si tratare clara pentru timeout.

3. Verificare finala AE import dupa guard
   - Status curent bun: stale running 4h = `0`, service guard success.
   - Mai exista `pending=1`, `running=1` fara stale. Trebuie urmarit pana la `done/skipped` final.
   - Fix doar daca ramane blocat: reset `running` vechi la `pending` sau marcheaza `skipped`, dupa inspectie log/eroare.

## P2 - Important

1. Trei cron-uri SEO inca folosesc comparatie directa de secret
   - Fisiere: `app/api/cron/bing-url-submit/route.ts`, `app/api/cron/indexnow/route.ts`, `app/api/cron/indexnow-submit/route.ts`.
   - Observatie: `token === expected` / `t === e` in helper auth.
   - Impact: timing attack teoretic pe rute SEO non-critice; inconsistent cu restul cron-urilor deja timing-safe.
   - Fix recomandat: helper comun `timingSafeEqual` pentru toate cron-urile.

2. Retentie backup/storage nedefinita
   - Date live: `/opt/swypik/backups=9.0G`, backup table `marketplace_product_variants_backup_20260527=2476 MB`, `/var/log/journal=4.1G`.
   - Logrotate pentru `/opt/swypik/logs/*.log` exista si e instalat, dar nu acopera backup/journal.
   - Fix recomandat: politica retention pentru backup-uri, decizie drop/archive pentru backup table, journal cap (`SystemMaxUse` sau vacuum programat).
   - Nota: drop/delete este destructiv si necesita confirmare.

3. Backup DB automat lipseste din repo/infra
   - Observatie: nu apare script/timer dedicat de `pg_dump` in `infra/hetzner`; exista doar volum persistent Docker.
   - Impact: productie stabila, dar nu disaster-ready.
   - Fix recomandat: script backup DB gzip + timer/cron + test restore lunar.

4. Docker image versioning limitat
   - Date live: doar `swypik-prod-web-next:latest` si `:rollback`.
   - Impact: rollback doar o versiune, fara audit trail istoric al imaginilor.
   - Fix recomandat: tag-uri timestamp+commit si cleanup ultimele N imagini; optional tabel `deploy_audit`.

5. Stripe/commerce hardening: status si fraud checks
   - Stripe idempotency P0 raportat de agent a fost fals pozitiv: `processed_stripe_events` are PK si handler-ul face claim atomic inainte de switch.
   - Ramane util: query-ul seller payout din `app/api/cron/process-payouts/route.ts` nu filtreaza explicit user/seller fraud block; datele live nu indica incident, dar codul poate fi intarit.
   - Fix recomandat: join `users` prin seller owner si exclude `metadata.fraud_user_block.blocked=true`, daca relatia este obligatorie in schema.

6. Feed RSS doar EN
   - Fisier: `app/feed.xml/route.ts`.
   - Observatie: `<language>en</language>`, titlu/descriere EN hardcodate.
   - Impact: SEO/i18n incomplet.
   - Fix recomandat: feed-uri localizate sau metadata per locale; minim seteaza corect default-ul RO si pregateste alternate feeds.

7. CheckoutForm imagini brute si texte RO
   - Fisier: `components/CheckoutForm.tsx`.
   - Observatie: doua `<img>` brute pentru produse, alt fallback `"Produs"`, multe texte RO hardcodate.
   - Impact: performanta/a11y/i18n.
   - Fix recomandat: migrare la `next/image` cu dimensiuni fixe si `useTranslations("checkout")`.

## P3 - Backlog / polish

1. i18n hardcoded RO ramas in UI/API visible
   - Zone: `components/CheckoutForm.tsx`, `components/ChatInterface.tsx`, `components/ProductDrawer.tsx`, `app/api/explore/feed/route.ts`, explore/categories/about/live/account.
   - Este proiect mare, nu patch cosmetic.

2. Raw `<img>` mai larg
   - Confirmat in cart/search/hashtag/profile/admin/seller/checkout.
   - Migrare treptata la `next/image` unde sursa si dimensiunile sunt stabile.

3. Video SEO landing redirect
   - Fisiere: `app/video/[id]/page.tsx`, `app/[locale]/video/[id]/page.tsx`.
   - Scriptul inline cu `window.location.href` este client-side si id-ul este `JSON.stringify(encodeURIComponent(id))`, deci nu este P1 SSR crash.
   - Totusi poate fi imbunatatit ca UX/SEO prin redirect server-side sau meta refresh.

4. Test coverage gaps
   - E2E acopera health, a11y, forms-autocomplete, perf; lipsesc unit/integration pentru auth OTP, cart merge, Stripe webhook duplicate, dropship race, payout race, rate-limit behavior.

5. Code quality cleanup
   - Exista `any`, catch-uri largi, unele `console.error` in loc de logger si componente mari (`ChatInterface`).
   - Nu sunt P0 in sine cat timp typecheck strict si deploy sunt verzi, dar merita sprint dedicat.

## False positives / respinse dupa validare

- `processed_stripe_events` fara PK: fals. PK prezent `processed_stripe_events_pkey`, duplicate = `0`.
- `commerce_order_items.creator_id` fara FK: fals. FK prezent.
- `tsconfig strict lipsa`: fals pe VPS. `strict: true`, `noEmit: true`, typecheck script exista.
- Cron auth P1 vechi `refresh-rank`/`strikes-decay`: rezolvat E23 cu `timingSafeEqual`.
- Video public adult/blocked: rezolvat E23 si validat `0`.
- Failed public videos: rezolvat E23 si validat `0`.
- `sendSellerNewOrderAlert` fara `return false` in catch: fals local, catch-ul returneaza `false`.
- Video page inline `window` ca SSR crash: exagerat; scriptul ruleaza in browser, nu in SSR execution context.

## Next actions recomandate

1. Patch rapid: cron SEO timing-safe + AE client timeout.
2. Patch dropship: `co.status='paid'` + recheck status inainte de AE placement.
3. Verifica/inchide AE import `pending=1/running=1` dupa cateva ore.
4. Decide retention: backup table 2.4GB si `/opt/swypik/backups` 9GB.
5. Adauga backup DB automat + test restore.
6. Batch i18n/checkout: `CheckoutForm` traduceri + `next/image`.
7. Sprint teste: Stripe duplicate webhook, dropship race, payout eligibility, cart merge.
