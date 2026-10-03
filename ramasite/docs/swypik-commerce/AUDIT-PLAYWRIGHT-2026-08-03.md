# Audit Playwright total — 2026-08-03

## Scor: 94/94 teste PASS (100%) — rulare finală completă, desktop + mobil

- 50 „skipped" = teste declarate doar pentru desktop (i18n, faze 3–5) rulate sub proiectul mobile — comportament intenționat prin `testInfo.skip(project !== 'desktop')`, nu skip tăcut. Fazele 1 (vizitator) rulează integral pe AMBELE proiecte (desktop 1280×720 + mobil 390×844).

## Inventar

- **146 pagini** (`tests/route-inventory-pages.txt`), **311 rute API** (`tests/route-inventory-api.txt`) — generate automat cu script.
- Crawl automat de la `/` (3 niveluri): 23 pagini vizitate + restul verificat cu GET; **0 link-uri moarte, 0 link-uri 500**.
- Suita: `tests/e2e-full/` — `00-discovery`, `01-visitor` (22×2 teste), `02-i18n` (29), `03-user` (9), `04-roles` (3), `05-negative` (8), `helpers.ts`, config propriu.
- Rulare: `npx playwright test --config tests/e2e-full/playwright.config.ts` (pt. faza 4 setează `E2E_SELLER_TOKEN` + `E2E_ADMIN_SECRET`).

## Bug-uri găsite ȘI REPARATE

| # | Bug | Cauza (fișier:linie) | Fix | Commit | Re-test |
|---|-----|----------------------|-----|--------|---------|
| 1 | Eroare consolă pe **TOATE** paginile: `upgrade-insecure-requests is ignored in report-only policy` (42 FAIL faza 1) | `next.config.mjs` ~L34 — directiva invalidă în `cspReportOnly` | eliminată din CSP Report-Only (rămâne în CSP enforce) | 31c62327 | PASS |
| 2 | 404 în explore: avatar cont oficial `/icons/icon-512.png` (fișierul e la `/icon-512.png`) | `scripts/seed-official-swypik.sql:14,22` + rând în DB | SQL corectat + `UPDATE users SET avatar_url=...` (1 rând) | cab63b85 | PASS |
| 3 | `/go`: geolocation blocat de `Permissions-Policy: geolocation=()` deși pagina îl folosește | `next.config.mjs:109` | `geolocation=(self)` | cab63b85 | PASS |
| 4 | **Like/save nelogat în explore eșua SILENȚIOS** — optimist update + rollback, zero feedback pt. user | `app/[locale]/explore/ExploreClient.tsx` `handleLike`/`handleSave` (~L368/L414) | la 401 → `router.push('/auth/login?next=/explore?v=<id>')` | eef450d5 | PASS |
| 5 | **notFound() în segmentul [locale] dădea ECRAN ALB** (`<html id="__next_error__">`) pe /product/, /v/, /missions/ cu ID inexistent | lipsea `app/[locale]/not-found.tsx` — Next cădea pe global-error | boundary `not-found.tsx` adăugat în `[locale]` | 3a33064a | PASS |

Toate cele 5 fixuri: commit → push → `wsl-deploy-web.sh` → re-run verde (dovadă în rulările din sesiune).

## Bug-uri găsite NEREPARATE

Niciunul. (Vezi FINDING-uri acceptate mai jos.)

### FINDING-uri acceptate (comportament corect, nu bug)
- `/go` face GET `/api/swyp/wallet` și nelogat → 401 best-effort (decide dacă afișează opțiunea de plată SWYP). Acceptabil; opțional s-ar putea sări fetch-ul când nu există cookie de sesiune (micro-optimizare).
- `/u/<inexistent>` întoarce **200** cu pagină „Profil negasit" elegantă (nu 404 HTTP). Funcțional OK; pentru SEO ar fi mai corect 404 — prioritate mică.
- Rate limit login/signup: agresiv dar funcțional (`Prea multe încercări`). A îngreunat rulările repetate de test — suita folosește acum cache de sesiune per email.

## Rute orfane / link-uri moarte

- **Link-uri moarte: 0.**
- **Rute orfane** (există dar nelegate din UI-ul public — de verificat intenția): `/apps`, `/auth/reset` (normal — vine din emailul de reset), `/cauze`, `/developers`, `/onboarding`, `/unsubscribe` (normal — vine din email).
- Practic de investigat: `/apps`, `/cauze`, `/developers` — dacă sunt destinate publicului, lipsesc link-urile spre ele.

## Console errors & failed requests per pagină (rămase)

- **Zero** pe toate paginile testate, după fixuri. Filtre documentate în `helpers.ts`: favicon/media aborts, `401 /api/swyp/wallet` nelogat (best-effort), `TypeError: Failed to fetch` la unmount pe navigare (anulare, nu bug).

## NETESTABIL (cu motiv + cum s-ar putea)

- **Plată reală Stripe** — regula 3 (fără plăți reale). Checkout dus până la pagina de plată. S-ar testa cu chei Stripe test + carduri de test.
- **Upload clip video end-to-end cu procesare** — pipeline-ul de procesare async necesită fișier + așteptare nedeterministă; pagina `/upload` și fluxul până la submit sunt acoperite indirect (fără crash). S-ar testa cu un mp4 mic + polling pe status.
- **LocaleSwitcher prin click pe toate cele 7 limbi** — acoperit parțial (navigare directă + un switch RO→EN verificat cu persistență la refresh).
- **Acțiuni admin distructive** (ban/delete/refund) — interzise pe date reale prin regulile auditului; secțiunile se deschid și se populează (22 secțiuni admin PASS).
- **Fluxuri seller CREATE/EDIT produs prin UI** — sesiunea seller a fost injectată (OTP-ul se trimite pe email real); toate cele 9 pagini seller se încarcă fără erori. Pentru CRUD complet: seller dedicat cu email `@swypik.test` (OTP-ul apare în log în acel caz).

## Cleanup efectuat

```sql
DELETE FROM seller_sessions WHERE seller_id IN (SELECT id FROM sellers WHERE email LIKE 'e2e_pw_%');  -- 1
DELETE FROM sellers WHERE email LIKE 'e2e_pw_%';                                                      -- 1
DELETE FROM users WHERE email LIKE 'e2e_pw_%@test.swypik.local';                                      -- 17 (cascade)
-- verificare: SELECT count(*) ... → 0 rămase
```
Plus: `UPDATE users SET avatar_url=replace(...)` (fix BUG 2, 1 rând — corecție, nu ștergere).

## Regresie de acum înainte

Suita e comisă în repo. Rulare:
```bash
npx playwright test --config tests/e2e-full/playwright.config.ts
# faza 4 completă:
E2E_ADMIN_SECRET=<ADMIN_SECRET din env prod> E2E_SELLER_TOKEN=<token sesiune seller> npx playwright test --config tests/e2e-full/playwright.config.ts 04-roles
```
Artifacts (screenshot/trace la FAIL): `tests/e2e-full/artifacts/` (gitignored).
