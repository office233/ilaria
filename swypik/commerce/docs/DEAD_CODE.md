# Inventar cod mort — Swypik

> Faza 0 (2026-08-02). Statusuri: ȘTERGE (sigur), ARHIVEAZĂ (mută în `scripts/archive/`), PĂSTREAZĂ (justificat). Ștergerea efectivă = Faza 4, cu commit dedicat.

> **Actualizare 2026-08-19 — `scripts/` reorganizat.**
> Inventarul de mai jos vorbește despre „170+ fișiere"; între timp s-a curățat
> deja jumătate, iar pe 19 august cele 86 rămase au fost grupate în directoare
> tematice. Vezi **`scripts/README.md`** pentru structura actuală și pentru
> lista completă a ce rulează automat.
>
> Ce s-a consolidat atunci:
> - `archive/` + `_archive/` → un singur `_archive/` (30 fișiere)
> - **7 scripturi de backup → 1.** Cele 5 din `scripts/` sunt arhivate: țintesc
>   containerul `swypik-postgres`, dezafectat odată cu VPS-ul (acum
>   `swypik-prod-postgres-1`). Sursa de adevăr: `infra/hetzner/backup-postgres.sh`.
>   Contrazice secțiunea „PĂSTREAZĂ — Backup" de mai jos, scrisă înainte de
>   migrarea în WSL.
> - `wsl-sync-i18n.sh`, `wsl-sync-tsc.sh` arhivate (cale moartă `/mnt/e/Meister`)
> - `swypik-reclassify-taxonomy.service` arhivat: referea un script deja șters
>   pe 5 august, în `375be6b9`
> - `test-deployment.sh` era comis cu CRLF — nu putea rula deloc în Linux
>
> Ce **nu** s-a mai confirmat din inventarul de mai jos: `check-independence.sh`
> și `seed-taxonomy-i18n.mjs` erau propuse la ȘTERGE/ARHIVEAZĂ, dar au fost
> păstrate în `diag/`, respectiv `data/` — costul păstrării unui script de
> diagnostic e zero, cel al negăsirii lui la nevoie nu.

## 1. Fișiere temporare în root-ul app/

| Fișier | Verdict |
|---|---|
| `tmp-missing-keys.json` | ȘTERGE — artefact audit i18n |
| `tmp-public-files.txt` | ȘTERGE — listing temporar |
| `tsc.log` | ȘTERGE — output compilare comis din greșeală; adaugă `*.log`, `tmp-*` în `.gitignore` |

## 2. Fișiere temporare în root-ul workspace-ului (E:\Meister)

`tmp-ns.txt`, `tmp_check_build.sh`, `tmp_rebuild.sh`, `tmp_smoke.sh`, `tsc_erp.txt`, `tsc_erp3.txt`, `tsc_sw3.txt` — ȘTERGE (nu sunt în niciun repo util).

## 3. scripts/ — categorii (170+ fișiere)

### ȘTERGE — VPS dezafectat (178.105.46.66)
Toate `vps-*.sh` (~28: vps-inventory, vps-teardown-*, vps-clean-*, vps-deploy-founding, vps-smoke-go, vps-apply-migrations, vps-full-backup, vps-disk-guard, e2e_vps_flow.sh, tmp-vps-audit.sh, compare-vps-local.sh, strip-swypik-nginx.py…). VPS-ul nu mai există; scripturile sunt istorice.

### ȘTERGE — one-shot i18n/migrare deja rulate
`add-i18n-lot7.mjs`, `fill-missing-i18n-part1..3.mjs`, `i18n-account-cards.mjs`, `i18n-fly.mjs`, `i18n-fly2.mjs`, `i18n-lot5-codemod.mjs`, `fix-dup-t.mjs`, `extract-i18n-strings.mjs`, `pad-historical-seo.mjs`, `seed-taxonomy-i18n.mjs`, `run-remaining-migrations.sh`, `run-todays-migrations.sh`, `apply-migration*.{mjs,ts}` (dacă `apply-local-migrations.mjs` rămâne canonical), `diag-products.sh`, `diag-products2.sh`, `fetch-test-clips2.sh`, `wsl-fix-*` one-shot, `wsl-restore-*2.sh` duplicate.

### ARHIVEAZĂ — debug/diagnostic ocazional
`wsl-debug-*.sh`, `wsl-json-diag.sh`, `wsl-gap-check.sh`, `audit-*.sh` one-shot (audit-final, audit-ready, audit-infra), `check-independence.sh`, `_tmp_disk_audit.sh`, `_tmp_start_all.sh`, `wait-build.sh`, `wait-deploy.sh`, `wsl-build-err.sh`.

### PĂSTREAZĂ — operaționale
- Audituri recurente: `scan-hardcoded.mjs`, `audit-i18n.mjs`, `audit-dead-code.mjs`, `check-env.mjs`, `i18n-guard.mjs`, `check-size.sh`
- Backup: `backup-all.sh`, `backup-db.sh`, `backup-postgres-r2.sh` (+README), `backup-prod.sh`, `secure-chain-backup.sh`, `verify-chain-backup.sh`
- Chain: `chain-balances.sh`, `check-gas-flow.sh`, `swypik-chain-health.sh`, `run-chain-tx.sh`, `check-wallets.sh`, `check-ledger-schema.sh`
- Deploy/ops WSL: `wsl-deploy-web.sh`, `wsl-rebuild-web.sh`, `wsl-status.sh`, `wsl-health-full.sh`, `wsl-install-crons.sh`, `wsl-install-dispatch-service.sh`, `wsl-verify-all.sh`, `wsl-cf-tunnel-setup.sh`, `wsl-install-cloudflared.sh`
- Test fluxuri: `test-*.mjs/ts/sh`, `smoke-mobility.sh`, `stripe-e2e-test.mjs`, `check-e2e-ready.sh`, `cleanup-e2e.sh`
- Cron/utilitare active: `dispatch-worker.mjs`, `process-payouts.mjs`, `enqueue-ae-videos-cron.sh`, `fly-price-watch-cron.sh`, `translate-*.mjs`, `retranslate-stale-products.mjs`, `sync-jamendo.mjs`, `import-*.mjs/sh`, seed-uri SQL

## 4. De verificat în Faza 4 (necesită grep de utilizare)

- Componente în `components/` neimportate nicăieri (rulează `scripts/audit-dead-code.mjs`)
- Rute API fără niciun apelant client și fără consumatori externi (cron/webhook/worker)
- `docs/` vechi contradictorii: `MASTER_PLAN.md`, `SWYPIK-SPECIFICATIE-COMPLETA.md` — marcate ca istorice sau actualizate
