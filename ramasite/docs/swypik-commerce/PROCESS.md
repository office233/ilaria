# Fluxul de lucru — când PR, când direct pe `main`

> Scris 21 august 2026, după ce am măsurat ce s-a întâmplat de fapt.

## Unde suntem

Practica PR-urilor a existat și s-a pierdut:

| | |
|---|---|
| Merge commits, total | **22** |
| Ultimul merge | **19 mai 2026** |
| Commituri directe pe `main` de atunci | **848** |
| Branch-uri de feature pe origin | 6 (`feat/blog-integration`, `fix/swypik-rate-limit`, `cleanup/18plus-removal`, …) |

Infrastructura e intactă — `ci.yml` rulează deja pe `pull_request`. S-a pierdut
doar obiceiul. Reluarea costă mai puțin decât adoptarea de la zero.

## Ce trebuie configurat pe GitHub

Nu se poate face din repo. În **Settings → Branches → Add rule** pe `main`:

| Setare | Valoare | De ce |
|---|---|---|
| Require a pull request before merging | **da** | fără asta, regula nu se aplică |
| Require approvals | **0** | ești singurul dezvoltator; 1 ar însemna să-ți aprobi singur PR-ul, adică un clic fără sens |
| Require status checks to pass | **da** | ăsta e tot rostul |
| Checks obligatorii | `lint-typecheck-build`, `python-workers`, `go-services` | cele trei job-uri din `ci.yml` |
| Require branches to be up to date | **nu** | un singur dezvoltator, fără curse între branch-uri |
| Dismiss stale reviews | irelevant | nu există reviewers |
| Include administrators | **da** | altfel te ocolești singur exact în ziua în care te grăbești |

`e2e.yml` rulează pe `pull_request` + `workflow_dispatch`, dar **nu** merită
pus obligatoriu: e lent și depinde de servicii externe. Un check obligatoriu
care pică din motive care nu țin de cod se dezactivează după a treia oară.

## Când PR și când nu

PR-ul adaugă frecare reală: branch, push, așteptat CI, merge. Pentru un singur
dezvoltator, frecarea aia se justifică doar unde greșeala costă.

**PR obligatoriu:**
- `app/api/**` — orice atinge o rută publică
- `lib/swyp/**`, `lib/payments/**`, `lib/stripe/**`, `app/api/checkout/**`,
  `app/api/webhooks/**` — codul care mișcă bani
- `db/migrations/**` — o migrare greșită nu se anulează cu `git revert`
- `infra/**`, `scripts/deploy/**`, `scripts/ops/**` — ce poate opri producția
- `middleware.ts`, `next.config.mjs` — efect global

**Commit direct, fără PR:**
- `docs/**`, `README`, comentarii
- `messages/**` (gardianul i18n rulează oricum la pre-commit)
- `scripts/diag/**`, `scripts/dev/**` — unelte locale
- teste noi care nu schimbă cod de producție

Regula de rezumat: **dacă o greșeală s-ar vedea abia în producție, treci prin PR.**

## Ce ar fi prins efectiv

Onest, din cele 8 probleme reale ale săptămânii 17-20 august, un „CI verde
obligatoriu înainte de merge" ar fi prins **2**:

| Problemă | Prins de CI? |
|---|---|
| `parseIds` exportat din `route.ts` (rupea `tsc`) | **da** — build eșuat |
| CRLF în `test-deployment.sh` | **da**, dacă CI-ar rula `bash -n` (nu o face; merită adăugat) |
| `viewerLiked` hardcodat + cache global | nu |
| Mutarea scripturilor rupe crontab-ul | nu |
| `scan-hardcoded.mjs` lipsă → gardian i18n rupt | nu |
| Backup fără bit de execuție | nu |
| Monitorizare de disc pe partiția greșită | nu |
| Politică GDPR fără implementare | nu |

**2 din 8.** Restul sunt decalaje între cod și mediul din jurul lui — crontab,
`/opt`, fișiere șterse, promisiuni juridice. Niciun CI nu le vede.

Asta nu e un argument împotriva PR-urilor: cele două prinse erau ambele
„build stricat împins pe main". Dar e un argument împotriva așteptării că
procesul rezolvă singur clasa de probleme care ne-a costat cel mai mult.

## Ce ar mai merita în CI

- `bash -n` pe toate `*.sh` — ar fi prins CRLF-ul; câteva secunde
- Semgrep — există deja `.semgrepignore` din 15 mai, dar nu rulează nicăieri
- verificare că fișierele referite din crontab și systemd chiar există —
  singura idee de aici care ar fi prins o problemă din categoria „decalaj"

## Regula `no-explicit-any`: două niveluri

`.eslintrc.json` tratează `any` diferit după cât costă greșeala:

| Unde | Nivel |
|---|---|
| `app/api/webhooks`, `app/api/checkout`, `app/api/orders`, `lib/stripe`, `lib/payments`, `lib/swyp`, `lib/security` | **`error`** |
| restul repo-ului | `warn` |

Zonele care mișcă bani au fost curățate complet (commit `24a9471f`), deci
pragul e zero și se poate menține. Un `any` acolo a ascuns deja un log care
raporta mereu `0` și o nepotrivire de formă la fulfillment — ambele invizibile
pentru `tsc` tocmai pentru că `as any` îi spunea să nu se uite.

Restul rămâne pe `warn`: 494 de apariții nu se curăță într-o sesiune, iar un
CI roșu permanent nu mai e citit de nimeni.
