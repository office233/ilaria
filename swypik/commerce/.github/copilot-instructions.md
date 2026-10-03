# Swypik — instrucțiuni globale pentru TOȚI agenții

## Hosting (actualizat 2026-09-28)
- Producția rulează pe **Azure** (`rg-swypik-prod`, swedencentral): VM-uri web-1/web-2 (web-next, platform-api, cloudflared; cron-worker doar pe web-1), data (Postgres 16 + Redis), worker (video-worker).
- Public prin **Cloudflare Tunnel `swypik-azure`** → https://swypik.com; media și backup-uri în R2 (`swypik-prod-media`, `swypik-prod-backups`).
- Deploy doar din git, de pe web-1: `sudo -iu dev bash /opt/swypik/app/infra/azure/deploy.sh` (vezi `CLAUDE.md`, `docs/infra/azure-cutover.md`).
- WSL (PC-ul de acasă) și Multi-ERP (erp.swypik.com) sunt RETRASE — nu le folosi. Instrumentul sellerului = panoul nativ `/seller`.
- **VPS 178.105.46.66** = DOAR Meister ERP (alt produs) — nu-l atinge.
- Cod sursă: `E:\Swypik\swypik\app` → branch → merge în `main`.

## Reguli tehnice
- Migrări în `db/migrations/` (`YYYYMMDD_NNNN_*.sql`), aplicate de `infra/azure/deploy.sh`.
- După orice schimbare de cod: `npx tsc --noEmit` înainte de commit.

## Direcție produs
- Plan: `docs/VIDEO_COMMERCE_ROADMAP.md` — „video sells everything" (clip → produs/masă/cameră/cursă).
- 5 verticale active: Video, Shop, Food, Stays, Go. NU adăuga verticale noi.
- Crypto/SWYP eliminat 2026-09-25 pentru eligibilitate NVIDIA Inception — tabelele DB rămân, neutilizate.
- Stripe Connect amânat (nu există cont) — payouts manual.

## Agenți specializați (folosește-l pe cel potrivit)
- `swypik-video` — feed, reels, ranking, video-workers
- `swypik-commerce` — Shop, Food, Stays, Go, checkout, selleri/merchanti
- `swypik-infra` — Azure, Docker, tunel Cloudflare, cron, deploy
