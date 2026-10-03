# Activare plăți Stripe — Swypik (ghid pas cu pas)

> Data: 2026-08-05 · Mediu: prod WSL (distro `swypik`, `https://swypik.com`)
> Scop: înlocuirea cheilor `sk_placeholder`/`pk_placeholder`/`whsec_placeholder` cu chei reale (TEST întâi, apoi LIVE) și verificarea fluxului complet de plată + webhook.

---

## 0. Starea actuală (verificat 2026-08-05)

| Ce | Valoare acum | Fișier |
|---|---|---|
| `STRIPE_SECRET_KEY` | `sk_placeholder` ❌ | `/opt/swypik/app/infra/hetzner/.env.production:12` |
| `STRIPE_WEBHOOK_SECRET` | `whsec_placeholder` ❌ | `:13` |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | `pk_placeholder` ❌ | `:14` |

Consecință: `getStripe()` (`lib/stripe/checkout.ts`) primește o cheie invalidă → `paymentIntents.create` aruncă `StripeAuthenticationError` → `create-intent` întoarce **503 „Plățile cu cardul nu sunt disponibile momentan"**. Nicio plată nu se poate finaliza.

### Infra confirmată live (2026-08-05)
- prod HEAD `be29379e`, `swypik-prod-web-next-1` **Up (healthy)**; 4 apariții `placeholder` în `.env.production` (cele 3 chei + 1 comentariu/valoare).
- Tabela de idempotență webhook `processed_stripe_events` **există** (coloane: `event_id`, `event_type`, `processed_at`; 0 rânduri — niciun eveniment procesat încă). Deci retry-urile Stripe sunt deja protejate.
- Client: `components/CheckoutForm.tsx` → `loadStripe(NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY)`; `StripePaymentForm.tsx` face `confirmPayment` cu `return_url = /checkout/success?order_id=...&token=...`.
- Pagina succes: `app/[locale]/checkout/success/page.tsx` verifică `payment_intent`/`session_id` + token cu `timingSafeEqual`.
- Flux: `create-intent` creează `commerce_orders(status=pending)` + PaymentIntent (`idempotencyKey pi:<orderId>`); webhook `payment_intent.succeeded` → `pending→paid` (gard `RETURNING`) + decrement stoc + fulfillment routing.

### Cum e cablat (important pt. deploy)
- `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` → **runtime** (citite din `env_file: .env.production` de containerul `web-next`). Se aplică la **restart**, fără rebuild.
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` → **build-time** (se inline-ază în bundle prin `ARG`/`ENV` în `docker-compose.prod.yml:23-45`). **Necesită rebuild** al imaginii `web-next`, NU doar restart.
- Webhook endpoint: `https://swypik.com/api/webhooks/stripe` (handler: `app/api/webhooks/stripe/route.ts`; rutat prin Caddy `handle /api/*` → `web-next:3000`).
- Evenimente tratate: `checkout.session.completed`, `payment_intent.succeeded`, `payment_intent.payment_failed`, `account.updated`, `charge.refunded`, `payment_intent.canceled`, `checkout.session.async_payment_failed/expired`, `charge.dispute.*`.

---

## 1. Obține cheile din Dashboard Stripe

### TEST (recomandat întâi)
1. https://dashboard.stripe.com/test/apikeys
2. Copiază **Secret key** → `sk_test_...`
3. Copiază **Publishable key** → `pk_test_...`

### Webhook (TEST)
4. https://dashboard.stripe.com/test/webhooks → **Add endpoint**
5. Endpoint URL: `https://swypik.com/api/webhooks/stripe`
6. Events to send — selectează exact:
   - `checkout.session.completed`
   - `payment_intent.succeeded`
   - `payment_intent.payment_failed`
   - `payment_intent.canceled`
   - `charge.refunded`
   - `account.updated`
   - `charge.dispute.created`, `.updated`, `.closed`, `.funds_withdrawn`, `.funds_reinstated`
   - `checkout.session.async_payment_failed`, `checkout.session.expired`
7. După creare → **Signing secret** → `whsec_...`

### LIVE (când ești gata de plăți reale)
- Aceleași, dar din https://dashboard.stripe.com/apikeys și https://dashboard.stripe.com/webhooks (fără `/test/`). Chei `sk_live_`/`pk_live_`.

---

## 2. Pune cheile în `.env.production` (DIRECT ÎN TERMINAL, nu în chat)

> ⚠️ NU trimite cheile prin chat. Le tastezi tu în terminalul WSL. Comanda de mai jos folosește `read -s` ca să nu apară pe ecran.

```bash
wsl -d swypik
cd /opt/swypik/app/infra/hetzner

# Backup înainte de orice
cp .env.production .env.production.bak.$(date +%Y%m%d_%H%M%S)

# Introducerea cheilor (tastate manual, nu ecou)
read -rsp 'STRIPE_SECRET_KEY: ' SK; echo
read -rsp 'STRIPE_WEBHOOK_SECRET: ' WH; echo
read -rsp 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: ' PK; echo

# Înlocuire în fișier (folosim | ca separator sed ca să nu ne încurce / din chei)
sed -i "s|^STRIPE_SECRET_KEY=.*|STRIPE_SECRET_KEY=${SK}|"                       .env.production
sed -i "s|^STRIPE_WEBHOOK_SECRET=.*|STRIPE_WEBHOOK_SECRET=${WH}|"               .env.production
sed -i "s|^NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=.*|NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=${PK}|" .env.production

# Curăță variabilele din shell
unset SK WH PK

# Verificare (afișează doar prefixul, restul mascat)
grep -E '^(STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY)=' .env.production \
  | sed -E 's/(=sk_[a-z]+_)[A-Za-z0-9]+/\1…/; s/(=pk_[a-z]+_)[A-Za-z0-9]+/\1…/; s/(=whsec_)[A-Za-z0-9]+/\1…/'
```

Rezultatul verificării trebuie să arate `sk_test_…`, `whsec_…`, `pk_test_…` (nu `placeholder`).

---

## 3. Rebuild + restart (pk e build-arg → OBLIGATORIU rebuild)

```bash
cd /opt/swypik/app
# pk publishable trebuie exportat ca env ca să ajungă build-arg în compose
export NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=$(grep '^NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=' infra/hetzner/.env.production | cut -d= -f2-)
bash scripts/deploy/wsl-deploy-web.sh
unset NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
```

> `wsl-deploy-web.sh` face `docker compose ... up -d --build web-next`. Compose ia `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` din environment-ul shell-ului (`${...:-}` în `args`) și îl inline-ază în bundle. `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` se citesc la runtime din `env_file`.

Așteaptă `web-next-1` → `Up (healthy)`.

---

## 4. Verificare flux plată (TEST)

### 4a. Cheia server e validă (nu mai dă 503)
```bash
# Adaugă un produs real în coș din UI, apoi checkout → create-intent trebuie să întoarcă clientSecret, nu 503.
# Sau direct pe un produs clasic (nu listing):
curl -s -X POST https://swypik.com/api/checkout/create-intent \
  -H 'Origin: https://swypik.com' -H 'content-type: application/json' \
  -d '{"products":[{"productId":"<UUID_PRODUS_CLASIC>","quantity":1}]}' | head -c 400
```
Așteptat: JSON cu `"success":true` și `"clientSecret":"pi_..._secret_..."` (NU 503).

### 4b. Plată cu card de test
- Card: `4242 4242 4242 4242`, orice dată viitoare, orice CVC, orice cod poștal.
- Comanda trebuie să treacă `pending → paid` (via webhook `payment_intent.succeeded`).

### 4c. Webhook chiar ajunge
```bash
# după o plată de test, verifică în DB că statusul s-a schimbat prin webhook:
docker exec swypik-prod-postgres-1 psql -U swypik -d swypik_prod -tA \
  -c "SELECT status, count(*) FROM commerce_orders GROUP BY status ORDER BY 2 DESC;"
# în Dashboard Stripe → Webhooks → endpoint → tab-ul de livrări: 200 OK pe evenimente.
```

---

## 5. Trecerea la LIVE
1. Repetă pasul 1 (LIVE) + pasul 2 cu chei `sk_live_`/`pk_live_` + webhook LIVE (`whsec_` din endpoint-ul live).
2. Repetă pasul 3 (rebuild — pk_live e alt build-arg).
3. Test cu o plată reală mică (ex. cel mai ieftin produs), verifică `paid` + payout Stripe.

---

## 6. Rollback rapid
```bash
cd /opt/swypik/app/infra/hetzner
cp .env.production.bak.<timestamp> .env.production
cd /opt/swypik/app && bash scripts/deploy/wsl-deploy-web.sh
```

---

## Checklist
- [ ] Chei TEST puse în `.env.production` (verificat cu grep mascat)
- [ ] Rebuild `web-next` (pk inline-at) → healthy
- [ ] `create-intent` întoarce `clientSecret` (nu 503)
- [ ] Plată `4242…` → comandă `paid`
- [ ] Webhook Stripe → 200 OK în Dashboard + status DB actualizat
- [ ] (Ulterior) Chei LIVE + rebuild + test plată reală mică

---

## Anexă tehnică (verificat în cod, 2026-08-05)

- **Versiune API Stripe pinned:** `2026-04-22.dahlia` (`lib/stripe/checkout.ts:20`). Contul Stripe trebuie să suporte această versiune (implicit la conturile noi; altfel Stripe o acceptă ca override per-request). Dacă apare `StripeInvalidRequestError: version`, actualizează string-ul la versiunea din Dashboard → Developers → API version.
- **SDK client:** `@stripe/stripe-js` + `@stripe/react-stripe-js` (Payment Element, nu Checkout hosted). Deci fluxul principal e **PaymentIntent + Payment Element**, iar `checkout.session.completed` e tratat doar ca fallback (unele verticale).
- **Return URL:** `/checkout/success?order_id=<id>&token=<orderLookupToken>` — succesul e reconfirmat server-side (nu se bazează pe redirect).
- **Plată hibridă SWYP:** `create-intent` debitează SWYP înainte de PaymentIntent; dacă Stripe eșuează la creare → `refundSwypForUnpaidOrder` + `status=failed`. La activarea cheilor reale, acest branch nu se mai declanșează pentru chei valide.
- **Idempotență completă:** `pi:<orderId>` (creare intent) + `processed_stripe_events(event_id)` (webhook) + gard `RETURNING` pe `pending→paid`. Retry-urile Stripe și dublu-click nu produc dublă plată/dublă decrementare de stoc.

### Debug rapid dacă plata eșuează după setarea cheilor
```bash
# log-urile web-next pentru erori Stripe la create-intent / webhook
wsl -d swypik
docker logs --tail 100 swypik-prod-web-next-1 2>&1 | grep -iE 'stripe|payment|webhook|create.intent'
```
- 503 la `create-intent` după setare = cheia `sk_` invalidă/greșit copiată sau container nerepornit.
- Webhook 400 „signature" = `STRIPE_WEBHOOK_SECRET` nu corespunde endpoint-ului creat în Dashboard.
- pk inline greșit (checkout crapă client-side cu „Invalid API Key") = ai uitat **rebuild**-ul (pk e build-arg, nu runtime).
