# Task Board Swypik — fronturi paralele (2026-08-01)

> Regulă: un front = un chat/agent. NU lucrați doi pe același folder.

## Front 1 — swypik-commerce (PRIORITAR, Faza 0)
- [ ] T1. Pagină publică `/food/aplica` — formular „Înscrie-ți restaurantul" → POST /api/merchants cu status='pending'
- [ ] T2. Secțiune merchants în `admin/aplicatii` — listă pending + buton aprobare → status='active'
- [ ] T3. Script import restaurante CSV (`scripts/import-merchants.mjs`) pentru orașul pilot
- [ ] T4. Șterge folderul gol `app/api/eats/`

## Front 2 — swypik-video (Faza 1 fundație)
- [ ] T5. Migrare `db/migrations/` pentru `video_attachments` (video_id, entity_type product|listing|merchant|cause, entity_id, creator_commission_bps, status) + `creator_commissions`
- [ ] T6. Migrare date: video↔product existente → video_attachments
- [ ] T7. API `POST/GET /api/videos/[id]/attachments`

## Front 3 — swypik-chain
- [ ] T8. Endpoint `/api/swyp/commission-proof/[id]` — dovada on-chain a unui comision (tx hash + link scan.swypik.com)
- [ ] T9. Verificare reconcile-wallets local (rulat manual 1×, viteza + corectitudine)

## Front 4 — swypik-infra (gardă)
- [ ] T10. Backup automat zilnic local → E:\backups (dump postgres + chaindata, cron WSL 03:00)
- [ ] T11. Healthcheck extern (cron: dacă swypik.com nu răspunde 3× → restart cloudflared + alertă)

## Reguli comune
- Editați în E:\Meister\swypik\app, `npx tsc --noEmit` înainte de commit, push pe main.
- Deploy local: git pull în /opt/swypik/app (WSL) + rebuild web-next.
- Marcați [x] aici la finalizare + commit.
