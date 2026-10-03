# AUDIT 2026 — CE A SCĂPAT (critic de completitudine)

## 1. Zone de pe disc neatinse de nicio felie
- `chain/` — 15 scripturi shell/python de infrastructură blockchain, incl. `chain/export-treasury-key.sh`, `chain/harden-rpc.sh`, `chain/add-rpc-landing.py`. Zero acoperire.
- `tools/` — 23 scripturi (`tools/gapscan.mjs`, `tools/audit-idor-enum.sh`, `tools/test-*.mjs`) — harness-ul propriu de audit, neverificat.
- `docs/qa/e2e/*.py` — 12 scenarii E2E Playwright în Python, paralele cu `tests/e2e*` în TS; nimeni nu a verificat dacă mai corespund rutelor.
- `packages/contracts/openapi/social-platform.v1.yaml` — singurul contract formal; nimeni nu l-a confruntat cu handler-ele din `services/platform-api/internal/platform/http/api.go`.
- `public/sw.js` — service worker care cache-uiește răspunsul de navigare al lui `/` (linia 49-52) și îl servește offline oricui folosește browserul.
- `messages/*.json` (8 locale) vs sutele de string-uri de eroare hardcodate în română direct în rutele API (ex. `app/api/checkout/route.ts:164,210,240`).
- `.github/workflows/ci.yml:59` — `npm audit --omit=dev ... || true` trece mereu; fără verificare de drift de migrări în CI (deși `tools/check-migration-drift.sh` există).
- `db/schema.sql` vs `db/migrations/` (191 fișiere) — nimeni nu a stabilit ce e aplicat efectiv în prod.

## 2. Lanțul banilor parcurs cap-coadă — unde se rupe

**Atenție structurală: există TREI implementări de checkout care scriu în aceleași tabele.**
`app/api/checkout/route.ts` (Stripe hosted) **nu e apelat de niciun client** — singurul consumator e `app/api/v1/[...path]/route.ts:24`. Calea VIE e `components/CheckoutForm.tsx:100` → `create-intent` → `_handlers/payments.ts`. Auditul a raportat bug-uri în `_handlers/checkout.ts` (cod practic mort) și a ratat calea reală.

1. **Video → coș: atribuirea se pierde complet.** `cart_items` nu are coloană video/creator, iar `app/api/cart/items/route.ts:129-138` nu salvează videoId. `components/CheckoutForm.tsx:53-63` mapează coșul fără `videoId` ⇒ `create-intent/route.ts:140` primește mereu `undefined` ⇒ `lib/checkout/attribution.ts:14` rulează fără filtru de video și alege un creator arbitrar (`ORDER BY placement, sort_order`). **Creatorul care a generat vânzarea nu ia comisionul; altul îl ia.**
2. **Coș → preț: se încasează alt preț decât cel afișat.** `CheckoutForm.tsx:56` trimite `skuId: it.variantId` (UUID din `cart_items.external_variant_id`), dar `create-intent/route.ts:134` caută `WHERE product_id=$1 AND sku=$2` ⇒ 0 rânduri ⇒ se taxează prețul de bază, nu al variantei din coș. `variantId` rămâne null ⇒ stocul se scade la nivel de produs (`payments.ts:403`), nu de variantă.
3. **Valută:** `create-intent/route.ts:201,286` hardcodează `'RON'`/`currency:"ron"` deși `lib/cart/session.ts:95` respectă `marketplace_products.currency`. Un produs în EUR se încasează ca RON.
4. **Webhook hosted — rutare spre seller moartă.** `_handlers/checkout.ts:207` citește `metadata.product_id ?? pg_id ?? i.id`, dar `lib/stripe/checkout.ts:67` scrie `productId` (camelCase) ⇒ `routableItems.productId = "li_xxx"` ⇒ `lib/fulfillment/order-router.ts:63` compune `externalLineItemId = "li_xxx:default"`, `stripeLineItemId = null` (obiectul nu are `.id`) ⇒ UPDATE-ul de la linia 104/120 prinde **0 rânduri**, `source_status` rămâne NULL. Tăcut: alerta de orfan (linia 66) cere ca AMBELE chei să lipsească, iar `rowCount` nu se verifică nicăieri.
5. Același fișier, linia 42: `item.metadata?.seller_id` vs `sellerId` scris la `lib/stripe/checkout.ts:69` ⇒ toate itemele cad în `plan.manual`, deci **`seller_payout_cents` (order-router.ts:98-102) nu se scrie niciodată** și emailul către seller (linia 199-212) nu pleacă. Idem `_handlers/checkout.ts:182` (`dispatchAppWebhook` nu se trimite niciodată).
6. **Seller → fulfillment:** `app/api/seller/orders/route.ts:158` marchează TOATE itemele sellerului din comandă ca `fulfilled` la un singur AWB, indiferent de item.
7. **Comision creator — niciodată plătit.** `app/api/cron/process-payouts/route.ts:126` face `JOIN creator_connect_accounts`, tabel declarat explicit gol și **nescris de aplicație** în `lib/stripe/connect.ts:3-5` (datele canonice sunt pe `users.stripe_connect_*`). Query-ul întoarce 0 rânduri întotdeauna.
8. Peste asta, tot cronul e scurtcircuitat de `isEnabled("stripeConnect")` (`process-payouts/route.ts:54`), flag `false` implicit în `lib/feature-flags.ts:16`. Nicio plată, seller sau creator, nu se execută în configurația curentă.
9. **Dashboard creator umflat:** `app/api/creator/earnings/route.ts:57-58` sumează toate `commerce_order_items` cu `creator_id`, fără JOIN pe `commerce_orders.status` ⇒ include comenzile `pending` create de `create-intent/route.ts:216` (coșuri abandonate).
10. **Refund vs payout:** `transfers.createReversal` nu apare nicăieri în cod. Refund după fereastra de 14 zile = pierdere netă. Iar `process-payouts/route.ts:101,137` exclud doar `('refunded','cancelled','return_requested','failed')` — **`partially_refunded`** (scris de `_handlers/refunds.ts:22`) nu e exclus, iar refundul parțial nu marchează niciun item (linia 41-62) ⇒ itemul refundat se plătește integral.
11. `db/schema.sql:1131` (`commerce_orders_status_check`) NU conține `partially_refunded`; există doar migrarea `db/migrations/20260825_0001_orders_partially_refunded.sql`. Dacă nu e aplicată în prod, orice refund parțial dă CHECK violation ⇒ `route.ts:134` eliberează claim-ul ⇒ retry Stripe la infinit, refund neînregistrat.
12. **Coșul nu se golește niciodată după plată.** Nu există nicio scriere `carts.status='converted'` sau ștergere de `cart_items` în afara acțiunii manuale (`app/api/cart/route.ts:34`). Utilizatorul revine cu coșul plin; cronul `abandoned-cart` îi trimite email pentru ce a cumpărat deja.
13. **Escaladarea constatării rămase deschise:** `services/platform-api/internal/checkout/service.go:26,41` acceptă `unit_amount_ron` ȘI `user_id` **direct de la client**, fără citire de preț din DB, și scrie în aceleași `commerce_orders`/`commerce_order_items` (`postgres_store.go:41,52`). Cu POST anonim la `/api/v1/*` purtând secretul intern, `POST /api/v1/checkout` cu `unit_amount_ron:1` creează comenzi cu preț ales de atacator. Nu e doar scurgere de proxy — e manipulare de preț.

## 3. Clase de erori pe care nu le-a căutat nimeni
1. **Coerență între căi paralele** — trei checkout-uri, două convenții de metadata (camelCase Stripe vs snake_case DB), două politici de preț (din DB vs din client). Fiecare felie a auditat un fișier; nimeni nu a comparat fișierele între ele.
2. **Cod mort pe calea critică** — nimeni nu a verificat *care* handler rulează efectiv. 350 de linii auditate (`_handlers/checkout.ts`) sunt neapelate; `_handlers/payments.ts` a fost ratat.
3. **UPDATE/DELETE care se potrivesc pe 0 rânduri** — `rowCount` neverificat (`order-router.ts:130`, `seller/orders/route.ts:158`). Eșecuri complet tăcute, fără excepție și fără log.
4. **Tabele fantomă** — cod care interoghează tabele pe care nimic nu le populează: `creator_connect_accounts`, `commissions`, `commission_payouts` (doar în `lib/social/creator-badges.ts`, `app/api/admin/finance/summary/route.ts`).
5. **Feature-flag × cron** — nimeni nu a enumerat ce funcționalitate e efectiv moartă pentru că un flag OFF scurtcircuitează un cron sau o rută (payouts, returns, fulfillment).
6. **Multi-valută și rotunjire** — tot lanțul presupune RON; `ronToCents` (`checkout/route.ts:31`) face dus-întors prin float pe bani.
7. **Drift schemă ↔ cod** — CHECK-uri și coloane pe care codul le presupune existente fără migrare aplicată (cazul `partially_refunded`).
8. **Stare care nu se închide** — coș neconvertit, comenzi `pending` acumulate la fiecare re-creare de PaymentIntent (`CheckoutForm.tsx:139` resetează `clientSecret` la orice modificare de coș), fără cron de curățare.
