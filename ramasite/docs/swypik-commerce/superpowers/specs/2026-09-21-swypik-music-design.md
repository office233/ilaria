# Swypik Music — design

**Data:** 2026-09-21 · **Stare:** decizii de produs confirmate, spec de aprobat · **Următorul pas:** plan de implementare

## 1. Decizii de produs (confirmate)

| Decizie | Valoare |
|---|---|
| Ce este | Platforma artiștilor independenți din ecosistemul Swypik, nu un serviciu de streaming cu catalog licențiat |
| Cine publică | **Artiști aprobați de admin** (`music_artists`) + **contul oficial Swypik** |
| Ascultare | **Gratuită** pentru toate piesele publicate (streaming) |
| Monetizare | **Tip cu SWYP** (5 / 10 / 25 SWYP) + **piese și albume premium** deblocate cu SWYP; artistul primește **70 %** instant, ca la Movies |
| Sunete pentru reels | **Da, implicit**; artistul poate opri per piesă (`allow_reels`); piesa apare atribuită pe clip |
| Navigație | „Swypik Music" în hamburger; mini-player persistent în toată aplicația |

## 2. Abordare

Reutilizăm tot ce a construit Movies: publisheri aprobați, prețuri în subunități SWYP, `swypTransferInTx` într-o singură tranzacție cu cotă instant pentru artist, token HMAC + proxy pe cale relativă pentru conținutul premium, taxonomie fixă de genuri, flag OFF până există conținut.

Tabela existentă `audio_tracks` (sunetele din reels, azi importate din Jamendo) devine **și** registrul de redare al Swypik Music: fiecare piesă publicată cu `allow_reels` primește un rând `audio_tracks` cu `source = 'swypik_music'`, deci recorder-ul și pagina `/audio/[id]` o găsesc fără nicio modificare.

## 3. Model de date — `db/migrations/2026MMDD_NNNN_music.sql`

```
music_artists
  user_id uuid PK → users · stage_name text · slug text UNIQUE · bio text · avatar_url · cover_url
  approved_by uuid → users · approved_at timestamptz · created_at · updated_at

music_albums
  id uuid PK · artist_user_id → users · title · slug UNIQUE · cover_url · release_date date
  status draft|pending_review|published|archived · price_units bigint NULL (NULL = nu se vinde ca album)
  created_at · updated_at

music_tracks
  id uuid PK · artist_user_id → users · album_id → music_albums NULL · track_number int NULL
  title · slug UNIQUE · cover_url · genre text (taxonomie fixă) · duration_ms int · explicit bool
  object_key text (R2, ex. music/<artist>/<id>.m4a) · public_url text NULL (doar pentru piese gratuite)
  is_premium bool DEFAULT false · price_units bigint NULL · allow_reels bool DEFAULT true
  audio_track_id bigint → audio_tracks NULL (rândul de „sunet" creat la publicare, dacă allow_reels)
  audience text general|kids DEFAULT 'general' · status draft|pending_review|published|archived
  moderation_status pending_review|approved|rejected · license_note text · published_at · created_at · updated_at

music_unlocks
  id uuid PK · user_id → users · track_id → music_tracks NULL · album_id → music_albums NULL
  units_paid · artist_share_units · ledger_ref · created_at
  UNIQUE (user_id, track_id) WHERE track_id IS NOT NULL · UNIQUE (user_id, album_id) WHERE album_id IS NOT NULL

music_tips
  id uuid PK · user_id → users · artist_user_id → users · track_id → music_tracks NULL
  units bigint · artist_share_units bigint · ledger_ref text · created_at
  (refId determinist: music_tip:<userId>:<uuid generat client-side, idempotency key>)

music_play_counters
  track_id → music_tracks · day date · plays int · PK (track_id, day)      -- agregat, fără user

music_playlists
  id uuid PK · user_id → users · title · is_liked_list bool DEFAULT false · created_at
music_playlist_items
  playlist_id → music_playlists · track_id → music_tracks · position int · added_at · PK (playlist_id, track_id)
```

Reguli pure în `lib/music/`:
- `canStream(viewer, track)`: publicată ∧ (¬premium ∨ unlock piesă ∨ unlock album ∨ viewer = artist ∨ admin)
- `artistShareUnits(amount, artistId, viewerId)` — 0 pentru contul oficial și pentru self-tip/self-unlock (același cod ca `creatorShareUnits`; se extrage în `lib/swyp/share.ts` și îl folosesc ambele verticale)
- `albumPriceUnits(album, tracks)` — prețul setat pe album, sau suma pieselor premium × (1 − `MUSIC_ALBUM_DISCOUNT_PCT`)

## 4. Upload și redare

- Upload: presigned PUT pe R2 (generalizăm `createVideoUploadUrl` în `lib/storage/media-upload.ts` cu prefix `music/raw`), fișiere MP3/M4A/WAV ≤ `MUSIC_MAX_UPLOAD_MB` (40). Un job în worker-ul existent (`video_worker`, handler nou `audio`) normalizează la AAC 192 kbps `.m4a`, extrage durata și un waveform PNG, scrie `music_tracks.duration_ms` + `object_key` și marchează `status='ready'`. Până la extinderea worker-ului, MVP acceptă doar M4A/MP3 și le servește ca atare (progresiv), durata citită în browser la upload.
- Redare: piesele gratuite au `public_url`; piesele premium se redau **doar** prin `/api/music/stream/<token>/<fișier>` (același `stream-token` + `stream-path`, mutate în `lib/media/`).
- Mini-player: `MusicPlayerProvider` în `app/[locale]/layout.tsx` (client), coadă, next/prev, progres, `MediaSession` API pentru lock-screen; persistă între navigări; ascuns pe `/go` și în player-ul Movies.

## 5. API (`FEATURE_MUSIC`, `withErrorHandling`, zod, rate-limit)

| Rută | Rol |
|---|---|
| `GET /api/music/home` | hero (artist/piesa featured), Top 10 piese (plays 7 zile), Noutăți, pe genuri, Lista „Îmi plac", playlist-uri |
| `GET /api/music/tracks?genre=&sort=&q=` | căutare/filtrare |
| `GET /api/music/artists/[slug]` · `GET /api/music/albums/[slug]` · `GET /api/music/tracks/[slug]` | pagini |
| `GET /api/music/tracks/[slug]/play` | 200 `{ url }` (public sau proxy cu token) · 402 `{ error:"locked", priceUnits, albumPriceUnits, balanceUnits }` |
| `POST /api/music/tracks/[slug]/unlock` · `POST /api/music/albums/[slug]/unlock` | `unlock.ts` (spend + cotă artist + rând unlock, o tranzacție, idempotent) |
| `POST /api/music/tips` `{ artistSlug, trackSlug?, units, idempotencyKey }` | tip: spend + cotă artist, unități din `MUSIC_TIP_PRESETS_UNITS` (500/1000/2500) |
| `POST /api/music/plays` `{ trackId }` | contor zilnic agregat (rate-limit per IP, fără user) |
| `GET/POST/PATCH/DELETE /api/music/playlists…` | playlist-uri + „Îmi plac" |
| `GET/POST /api/creator/music/tracks`, `PATCH …/[id]`, `POST …/upload-url`, `POST …/[id]/publish` | studio artist |
| `GET/PATCH /api/admin/music/tracks`, `POST /api/admin/music/artists` | aprobare artiști, review, publicare |

Publicarea unei piese cu `allow_reels`: în aceeași tranzacție, `INSERT INTO audio_tracks (source='swypik_music', source_id=track.id, title, artist=stage_name, duration_s, audio_url=public_url, image_url=cover_url, genre, license='swypik-artist', is_active=true)` și `music_tracks.audio_track_id` = id-ul creat. Piesele premium nu devin sunete (nu au `public_url`).

## 6. UI (`app/[locale]/music/…`, namespace `music`, 7 locale)

- **`/music`** — wordmark „SWYPIK MUSIC" (același font de afișare ca Movies, accent violet Swypik `#7C3AED`), chip-uri de genuri, hero cu artistul/piesa featured și buton Play, rânduri: Top 10 (cifre mari), Noutăți, Swypik Originals, pe genuri, „Îmi plac", playlist-urile mele.
- **Artist** — cover, avatar, bio, buton **Susține** (tip cu 3 presetări + sumă liberă), discografie (albume + piese), „Sunete pentru reels" (câte clipuri folosesc piesele).
- **Piesă** — copertă mare, Play, Îmi place, + Playlist, Susține, „Folosește în reel" (deschide recorder-ul cu `audio_track_id`), paywall pentru premium (preț piesă / album).
- **Studio artist** (`/creator/music`) — upload cu progres, metadate, gen, premium + preț, `allow_reels`, trimite la review; câștiguri (tips + unlock-uri).
- **Admin** (`/admin/music`) — artiști (aprobare), piese în review, publicare/arhivare.
- **Hamburger:** „Swypik Music" (`NEXT_PUBLIC_FEATURE_MUSIC`).

## 7. Siguranță, drepturi, anti-fraudă
- `license_note` obligatoriu la publicare (artistul declară că deține drepturile); moderare AI pe titlu/copertă + review admin.
- Tip și unlock: `refId` determinist, cotă 0 pentru self și pentru contul oficial, rate-limit `musicTip` 10/min, `musicUnlock` 10/min; plafon zilnic opțional pe cota artistului.
- Play counters fără identitate (nu se stochează cine a ascultat); Top 10 se bazează pe plays din ultimele 7 zile.

## 8. Faze
1. **MVP:** migrare, `lib/music/*` (TDD), upload direct M4A/MP3, API, mini-player, `/music`, artist, piesă, studio, admin, tips, premium, sunete pentru reels, i18n, flag.
2. Worker audio (normalizare AAC + waveform), lyrics, statistici pentru artiști, playlist-uri publice, share cards.
3. Kids: piese `audience='kids'` intră în Swypik Kids.

## 9. Testare
- Unit: `canStream`, `albumPriceUnits`, `artistShareUnits` (partajat cu Movies), unlock + tip cu DB mock (idempotență, sold insuficient, self-tip fără cotă).
- API: 402 → 200 după unlock; tip creditat o dată la retry cu același `idempotencyKey`; piesa premium absentă din `audio_tracks`.
