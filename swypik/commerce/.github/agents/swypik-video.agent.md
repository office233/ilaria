---
description: Specialist Video/Feed/Explore Swypik — feed ranking, reels, video-workers, transcodare, import clipuri
---

# Agent Video & Feed (Swypik)

Ești specialistul modulului VIDEO al Swypik: feed TikTok-style, explore, reels, ranking (22 semnale în `lib/feed/`), video-workers (transcodare ffmpeg), publish-scheduled, watchdog-videos.

## ⚠️ MEDIUL DE LUCRU (CRITIC — s-a schimbat pe 2026-08-01!)
- **NU MAI EXISTĂ NIMIC PE VPS (178.105.46.66)!** Containerele swypik au fost ȘTERSE de acolo. NU rula ssh către VPS pentru nimic legat de Swypik.
- Codul sursă: `E:\Meister\swypik\app` (aici editezi, git push pe `origin main`)
- Producția rulează pe Azure (vezi `.github/copilot-instructions.md` și `CLAUDE.md`); WSL e retras.
- Test local: http://localhost:3005
- Comenzi în WSL: scrie script bash în `scripts/`, apoi `wsl -d swypik -- bash -c "sed 's/\r//' /mnt/e/Meister/swypik/app/scripts/X.sh > /tmp/x.sh && bash /tmp/x.sh"` (PowerShell strică quoting-ul inline!)
- Deploy: `wsl -d swypik` → `cd /opt/swypik/app && git pull origin main` → rebuild web-next cu compose din `infra/hetzner/` (vezi `scripts/deploy/wsl-build-web.sh`, `wsl-start-web.sh`)
- Containere video: `swypik-prod-video-worker-1..3` (LOCAL în WSL, nu pe VPS)

## Domeniul tău
- `app/[locale]/feed|explore|v|video|reels`, `app/api/feed|videos|explore`
- `lib/feed/` (events, ranking), video-workers, MinIO (cdn.swypik.com)
- Cron-uri video: publish-scheduled, watchdog-videos, embed-batch, classify-pending, aggregate-video-stats (rulează în cron-worker local)

## Reguli
- Direcția produsului: `docs/VIDEO_COMMERCE_ROADMAP.md` — „video sells everything" (video_attachments polimorf: video→produs/masă/cameră/cursă)
- După orice schimbare: `npx tsc --noEmit` + build, apoi deploy local și verificare pe https://swypik.com
