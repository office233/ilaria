# scripts/

Reorganizat pe 19 august 2026: 86 de fișiere plate + două directoare de arhivă
→ 8 directoare tematice, cu 5 fișiere rămase la rădăcină.

Regula de bază: **la rădăcină stă doar ce e invocat automat.** Restul e grupat
după ce faci cu el.

## Ce rulează singur

| Ce | De unde | Când |
|---|---|---|
| `ops/disk-watch.sh` | crontab gazdă WSL | orar |
| `../infra/hetzner/backup-postgres.sh` | crontab gazdă WSL | zilnic 03:15 |
| `i18n-guard.mjs` | `.githooks/pre-commit` | la fiecare commit |
| `dispatch-worker.mjs` | `npm run worker:dispatch` | manual/serviciu |
| `process-payouts.mjs` | `npm run payouts:process` | manual |
| `test-dispatch.mjs` | `npm run test:dispatch` | manual |
| `test-payments.ts` | `npm run test:payments` | manual |

Restul joburilor recurente **nu** sunt scripturi de aici: rulează din
`infra/hetzner/cron-worker/run.sh`, care lovește rute `/api/cron/*`.

> Hook-ul de pre-commit a fost **reactivat** pe 19 august
> (`git config core.hooksPath .githooks`) — era dezactivat local, pe `/dev/null`.
> Reactivarea a scos la iveală că `i18n-guard.mjs` era rupt: apela
> `scan-hardcoded.mjs`, șters în `80b08aae`, și ieșea cu 1 după ce trecea
> celelalte verificări. Ar fi blocat orice commit pe UI. Reparat în `ad8327d8`:
> verificarea lipsă e acum sărită cu avertisment, nu fatală.
>
> `core.hooksPath` e configurație **locală**, nu se propagă prin git. Pe un
> clone nou trebuie rulat din nou.

## Directoare

| Director | Ce conține |
|---|---|
| `deploy/` | `wsl-deploy-web.sh` (folosit la fiecare deploy), build, iconițe |
| `ops/` | ce ține producția în viață: disk-watch, chain-health, backup chain, check-env |
| `db/` | migrări: apply, run-remaining, plus utilitarele existente |
| `data/` | import (ERP, OSM, comercianți), traduceri, seed-uri SQL, sync media |
| `diag/` | diagnostic ad-hoc: `check-*`, fluxuri e2e, teste care ating DB-ul real |
| `dev/` | utilitare locale de dezvoltare (`wsl-*`: status, sql, vitest, tsc) |
| `eval/`, `lib/`, `translator/` | existente dinainte, neatinse |
| `_archive/` | nefolosit, dar păstrat. Nu se șterge nimic definitiv. |

## De ce e ceva în `_archive/`

- **5 scripturi de backup** (`backup-all`, `backup-db`, `backup-prod`,
  `backup-postgres-r2` + README) — din era VPS-ului dezafectat.
  `scripts/backup-db.sh` țintea containerul `swypik-postgres`, care nu mai
  există (e `swypik-prod-postgres-1`), deci ar fi eșuat la prima comandă.
  Sursa de adevăr e acum **`infra/hetzner/backup-postgres.sh`**.
- **`wsl-sync-i18n.sh`, `wsl-sync-tsc.sh`** — copiau din `/mnt/e/Meister/swypik/app`,
  o copie a codului din 5 august care încă există pe disc. Rulate din greșeală,
  ar fi suprascris `/opt` cu cod vechi.
- **30 de fișiere** din vechile `archive/` și `_archive/`, unificate.

## Reguli

1. Un script nou care rulează automat → la rădăcină sau în `ops/`, **și** notat
   în tabelul de mai sus.
2. Nu se șterge nimic — se mută în `_archive/`.
3. Mutarea unui script referit din crontab se face **împreună** cu actualizarea
   crontab-ului, dar abia **după** ce deploy-ul a dus fișierul în `/opt`
   (vezi nota din `docs/DEPLOY.md`).
4. Scripturile `.sh` se scriu cu terminații LF — impus acum de `.gitattributes`
   (`*.sh text eol=lf`). Un fișier comis cu CRLF nu rulează în Linux; s-a
   întâmplat cu `test-deployment.sh`.
5. Pe un clone nou: `git config core.hooksPath .githooks`, altfel gardianul
   i18n nu rulează la commit.
