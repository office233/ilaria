# Release 2026-09-22 — Swypik Music

Ce conține (branch-ul cu Swypik Music, peste ultimul deploy cu Movies):

1. Migrarea `db/migrations/20260922_0001_music.sql` — `music_artists`, `music_albums`,
   `music_tracks`, `music_unlocks`, `music_tips`, `music_play_counters`,
   `music_playlists`, `music_playlist_items` (idempotent, `CREATE ... IF NOT EXISTS`;
   constrângerea UNIQUE pe `audio_tracks (source, source_id)` există deja în schemă).
2. `lib/media/*` (mutat din `lib/movies/*`: `stream-token.ts`, `stream-path.ts`,
   `stream-secret.ts`, `hls-rewrite.ts` — comun Movies + Music) și `lib/swyp/share.ts`
   (`platformShareUnits`, cota partajată — 0 pentru contul oficial și self-plăți).
3. `lib/music/*` (config, tipuri, taxonomie de genuri, acces/preț, repository,
   publicare cu sincronizare `audio_tracks`, unlock + tip SWYP), API sub
   `app/api/music/**`, `app/api/creator/music/**`, `app/api/admin/music/**`,
   componente `components/music/*` (mini-player persistent, `TrackRow`, `TipSheet`,
   `MusicPaywall`, `GenreChips`), pagini publice `app/[locale]/music/**`, studio
   artist `app/creator/(dashboard)/music`, admin `app/admin/music`.

> **Corecție 2026-09-22:** nu există VPS. Hosting-ul e distro-ul WSL2 `swypik` de pe PC-ul local (`wsl -d swypik -u root`), clona live `/opt/swypik/app`, compose `prod.yml + vps.yml + minio.yml`, fără Caddy (tunel Cloudflare → `localhost:3005`; pasul „restart caddy" nu se aplică, iar `X-Real-IP` nu e setat de niciun proxy — `getClientIP` cade pe ultimul hop din `X-Forwarded-For`, pe care Cloudflare îl adaugă el). Pașii se rulează în distro; procedura reală e în `CLAUDE.md` → Workflow și în `E:\Swypik\deploy-step-*.sh`.

## Pe VPS (`root@46.224.197.2`, `/opt/swypik/app`) — ISTORIC, vezi corecția de mai sus

```bash
cd /opt/swypik/app

# 1. Backup DB înainte de migrări (regula 4 din CLAUDE.md)
docker exec swypik-prod-postgres-1 sh -c 'pg_dump -U $POSTGRES_USER $POSTGRES_DB' \
  | gzip > /opt/swypik/backups/pre-music-$(date +%Y%m%d-%H%M).sql.gz

# 2. Flag-urile Music în env (NEXT_PUBLIC_* se inlinează la build, deci ÎNAINTE de build)
grep -qE '^FEATURE_MUSIC=' infra/hetzner/.env.production || cat >> infra/hetzner/.env.production <<'EOF'
FEATURE_MUSIC=1
NEXT_PUBLIC_FEATURE_MUSIC=1
EOF

# Restul variabilelor Music au fallback-uri rezonabile (vezi .env.example) — nu sunt
# obligatorii, dar verifică-le dacă vrei alte limite decât cele implicite:
#   MUSIC_ARTIST_SHARE_BPS=7000 MUSIC_ALBUM_DISCOUNT_PCT=30
#   MUSIC_TRACK_PRICE_MIN_UNITS=100 MUSIC_TRACK_PRICE_MAX_UNITS=2000
#   MUSIC_DEFAULT_TRACK_PRICE_UNITS=300 MUSIC_TIP_MAX_UNITS=50000
#   MUSIC_MAX_UPLOAD_MB=40 MUSIC_MAX_DURATION_MIN=30 MUSIC_STREAM_TOKEN_TTL_S=900

# Obligatoriu pentru token-urile de stream (partajat cu Movies — există deja):
grep -q '^APP_ENCRYPTION_KEY=' infra/hetzner/.env.production || echo "LIPSEȘTE APP_ENCRYPTION_KEY"
# Obligatoriu pentru upload-ul direct pe R2 (S3_* sau R2_* — vezi lib/storage/video-storage.ts):
grep -qE '^(S3|R2)_ENDPOINT' infra/hetzner/.env.production || echo "LIPSEȘTE S3_ENDPOINT / R2_ENDPOINT"
grep -qE '^(S3|R2)_ACCESS_KEY' infra/hetzner/.env.production || echo "LIPSEȘTE S3_ACCESS_KEY / R2_ACCESS_KEY_ID"
grep -qE '^(S3|R2)_SECRET_KEY' infra/hetzner/.env.production || echo "LIPSEȘTE S3_SECRET_KEY / R2_SECRET_ACCESS_KEY"
# Obligatoriu pentru dedup-ul de plays (rate-limit anti-umflare Top 10 — lib/redis.ts):
grep -q '^REDIS_URL=' infra/hetzner/.env.production || echo "LIPSEȘTE REDIS_URL"

# 3. Deploy (pull main, aplică TOATE migrările idempotent — inclusiv 20260922_0001_music.sql —
#    rebuild, restart, health check)
bash infra/hetzner/deploy.sh

# 3b. Caddyfile-ul setează acum `X-Real-IP` din {remote_host} pe rutele web-next
#     (rate-limit și dedup-ul de plays nu mai pot fi păcălite cu un header trimis de client);
#     `up -d` nu reîncarcă configul Caddy dacă doar Caddyfile-ul s-a schimbat:
docker compose -f infra/hetzner/docker-compose.prod.yml restart caddy

# 4. Smoke test
curl -s -o /dev/null -w '%{http_code}\n' https://swypik.com/api/health              # 200
curl -s -o /dev/null -w '%{http_code}\n' https://swypik.com/api/music/home          # 200
curl -s -o /dev/null -w '%{http_code}\n' https://swypik.com/music                   # 200
curl -s -o /dev/null -w '%{http_code}\n' https://swypik.com/api/music/tracks/nope/play  # 404
```

Dacă `deploy.sh` nu aplică migrarea (aplic-o manual):

```bash
./scripts/db/apply-migration.sh db/migrations/20260922_0001_music.sql
```

## După deploy

1. `POST /api/admin/music/artists` (sau `/admin/music` → tab Artiști → „Aprobă artist")
   cu ID-ul contului oficial Swypik (`NEXT_PUBLIC_SWYPIK_OFFICIAL_USER_ID`) — devine
   artist Music cu cotă 0 pe orice deblocare/tip (self-plată/cont oficial).
2. Din contul oficial: `/creator/music` → încarcă prima piesă (fișier audio, gen,
   notă de licență obligatorie) → se trimite automat la review (`pending_review`).
3. `/admin/music` → tab Piese → Aprobă → Publică. Dacă piesa e gratuită și are
   „Permite în reels" bifat, publicarea creează/actualizează rândul din `audio_tracks`
   (`source='swypik_music'`) — piesele premium sau cu `allow_reels=false` NU ajung
   niciodată acolo (verifică `lib/music/publish.ts` → `audioTrackRowFor`).
4. Verifică sunetul în recorder-ul de reels: `GET /api/audio/tracks?q=<titlul piesei>`
   trebuie să întoarcă rândul nou (sau caută piesa direct în picker-ul de sunete din
   `/record`).
5. Verifică o deblocare cu SWYP dintr-un cont de test (piesă/album premium) și că
   ledger-ul are două intrări cu același `ref_id` (`music_unlock` + `music_artist_share`)
   — pentru piesele contului oficial sau self-plăți cota e 0, deci o singură intrare.
   La fel pentru un tip (`music_tip` + `music_artist_share`); retrimiterea aceluiași
   `idempotencyKey` nu trebuie să debiteze a doua oară (`alreadyApplied`).

## Rollback

`FEATURE_MUSIC=0` + `NEXT_PUBLIC_FEATURE_MUSIC=0` în env și rebuild `web-next`:
rutele `/api/music/**`, `/api/creator/music/**`, `/api/admin/music/**` răspund 410
prin `frozenResponse("music")`, iar paginile publice `/music/**` dau `notFound()`.
`/creator/music` și `/admin/music` (și intrările lor din meniu) nu sunt încă gated pe
flag (Task 12 — notat ca datorie, la fel ca `CategorySidebar`) — paginile se randează,
dar orice apel către API-ul Music eșuează cu 410, deci practic nefuncționale. Tabelele
`music_*` rămân (goale sau nu) și nu afectează restul aplicației; rândurile deja
scrise în `audio_tracks` pentru piese publicate rămân active (sunetele continuă să
funcționeze în reels-urile existente), dar nu se mai pot publica altele noi cât timp
flag-ul e OFF.
