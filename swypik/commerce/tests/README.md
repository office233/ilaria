# Teste Swypik

| Suită | Comandă | Rulează în CI | Poate scrie date |
| --- | --- | --- | --- |
| Unit (vitest) | `npm run test` | da | nu |
| e2e smoke (`e2e/`) | `npm run test:e2e -- --project=mobile` | da, pe PR | nu |
| e2e complet (`e2e-full/`) | `npx playwright test --project=full-desktop` | **nu** | **da** |

Configurarea e într-un singur fișier: `playwright.config.ts` la rădăcină.
Cele patru proiecte (`mobile`, `desktop`, `full-desktop`, `full-mobile`) își
aleg singure `testDir`.

## Guard anti-producție

Ținta implicită e `http://localhost:3000`. Rularea împotriva
`swypik.com` cere `ALLOW_PROD_E2E=1` — altfel configurarea aruncă înainte de a
porni vreun browser.

Motivul: până pe 2026-08-17 valoarea implicită era producția. Spec-urile din
`e2e/` sunt read-only, deci nu s-a stricat nimic, dar există **20 de conturi
`*@test.*` suspendate** în `swypik_prod` — urme ale unor rulări anterioare.
Un singur spec de checkout rulat din greșeală ar fi adăugat comenzi reale peste
cele 13 existente.

Workflow-ul `e2e.yml` setează `ALLOW_PROD_E2E=1` deliberat: face smoke-testing
pe producție, dar numai cu proiectul `mobile`.

## De ce `e2e-full/` nu rulează

Nu îi lipsesc testele — sunt 31 KB, cu `helpers.ts` care rezolvă deja signup,
login și reutilizarea sesiunilor. Îi lipsește **un loc unde să scrie**:

- `helpers.ts:50` — `apiSignup()` creează conturi reale prin `/api/auth`
- `03-user.spec.ts` — parcurge fluxuri de utilizator autentificat

Pe producție ar polua baza la fiecare rulare. De aceea nu e în CI.

## Ce ar fi necesar pentru un mediu de test

Verificat pe 2026-08-17 — niciunul dintre acestea nu există momentan:

**1. Stack izolat** (blocant, efort mediu)
Nu există containere `dev`/`staging`/`test`, iar pe Postgres sunt doar
`postgres` și `swypik_prod`. `.env.local` trimite spre `swypik_dev` pe
`localhost:15433` — port închis; era un tunel SSH către VPS-ul care nu mai e
folosit. Ar trebui un `docker-compose.test.yml` cu postgres + web-next pe
porturi separate și o bază populată din `db/schema.sql` (regenerat din prod în
august, deci corect).

**2. Chei Stripe de test** (blocant pentru checkout, efort mic)
`.env.production` are `sk_placeholder` / `pk_placeholder` — nici test, nici
live. Fără `sk_test_…`, un test de checkout cu cardul `4242…` nu poate exista.

Pentru webhook, varianta recomandată e **POST semnat manual** către
`/api/webhooks/stripe`: semnătura se construiește cu `STRIPE_WEBHOOK_SECRET` și
`crypto.createHmac`, deci e deterministă și rulabilă în CI, fără Stripe CLI și
fără tunel.

**3. Fixture-uri cu marker** (efort mic, după 1 și 2)
Conturile de test folosesc deja prefixul `e2e_pw_` (`helpers.ts:44`) — ușor de
identificat și de curățat. Aceeași convenție ar trebui aplicată produselor și
comenzilor de test, ca ștergerea să nu poată atinge date reale.

## Ce ar prinde testele care lipsesc

Două fluxuri, în ordinea valorii:

1. **checkout** — ar fi prins P0-01 (comandă `paid` fără items). Cel mai valoros.
2. **upload** — cel mai lent. Merită evaluat întâi ca test de integrare direct
   pe `video-worker`, fără browser: un e2e de 2 minute ajunge să fie dezactivat.

## Cum se pornește, când vor exista

```bash
# 1. stack de test
docker compose -f docker-compose.test.yml up -d

# 2. suita completă
PLAYWRIGHT_BASE_URL=http://localhost:3000 npx playwright test --project=full-desktop

# 3. un singur fișier
PLAYWRIGHT_BASE_URL=http://localhost:3000 npx playwright test tests/e2e-full/03-user.spec.ts
```

`artifacts/` (sesiuni, trace-uri, capturi) e ignorat de git prin
`tests/e2e-full/.gitignore`. Sesiunile salvate local conțin cookie-uri de
autentificare valide — nu le comite.
