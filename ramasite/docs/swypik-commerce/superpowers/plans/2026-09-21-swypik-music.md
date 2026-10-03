# Swypik Music — plan de implementare

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Platforma artiștilor independenți: artiști aprobați publică piese/albume (upload direct pe R2), ascultare gratuită cu mini-player persistent, tip cu SWYP și piese/albume premium deblocate cu SWYP (cotă instant 70 % artistului), piesele devin sunete pentru reels; totul după `FEATURE_MUSIC`.

**Architecture:** Aceeași coloană vertebrală ca Movies: publisheri aprobați, reguli pure în `lib/music/*`, bani doar prin `swypTransferInTx` într-o tranzacție, conținut premium servit prin proxy cu token HMAC pe cale relativă (helperii mutați în `lib/media/`), taxonomie fixă de genuri, flag OFF. `audio_tracks` (sunetele din reels) primește un rând la publicarea pieselor cu `allow_reels`, deci recorder-ul le vede fără modificări.

**Tech Stack:** Next.js 15 App Router, TypeScript strict, PostgreSQL SQL brut, zod, next-intl (7 locale), vitest, R2 presigned PUT, `<audio>` + MediaSession API.

**Spec:** `docs/superpowers/specs/2026-09-21-swypik-music-design.md`

## Global Constraints

- Toate textele UI prin `next-intl`, chei în toate cele 7 fișiere `messages/*.json` (pre-commit `scripts/i18n-guard.mjs`).
- Zero `any` nou; erori către client doar coduri; toate rutele cu `withErrorHandling`, zod prin `parseBody`, `rateLimit`.
- Numere magice doar în `lib/music/config.ts` (env cu fallback).
- Flag `FEATURE_MUSIC` / `NEXT_PUBLIC_FEATURE_MUSIC`, implicit OFF; rute → `frozenResponse("music")`, pagini → `notFound()`.
- Migrări idempotente; comenzi din `E:\Swypik\swypik\app`; gate-uri: `npx tsc --noEmit --incremental false`, `npx vitest run`, `npx eslint <fișiere>`, la final `npx next build`.
- Commit-uri mici în română cu `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. **Tip trimis de două ori (retry de rețea):** același `idempotencyKey` ⇒ un singur debit — pinned în Task 5 (`tipArtist` cu refId determinist + UNIQUE pe `(user_id, idempotency_key)`).
2. **Artist care își dă tip singur / își deblochează propria piesă:** cotă 0 — pinned în Task 1 (`platformShareUnits`) și Task 5.
3. **Piesă premium care ajunge în `audio_tracks` (sunet public):** interzis — pinned în Task 4 (`audioTrackRowFor` întoarce `null` pentru premium) și Task 8 (publicarea).
4. **Retragerea `allow_reels` după publicare:** rândul din `audio_tracks` devine `is_active=false` — pinned în Task 4 (`syncAudioTrack`).
5. **Contorul de plays ca vector de umflare a Top 10:** rate-limit per IP + un play numărat per (IP, piesă, 10 min) în Redis — pinned în Task 6.

---

## Structura fișierelor

| Fișier | Responsabilitate |
|---|---|
| `lib/media/stream-token.ts`, `stream-path.ts`, `stream-secret.ts`, `hls-rewrite.ts` | mutate din `lib/movies/` (folosite de Movies și Music) |
| `lib/swyp/share.ts` | `platformShareUnits` (cota partajată: 0 pentru oficial/self) |
| `db/migrations/20260922_0001_music.sql` | tabelele Music |
| `lib/music/config.ts`, `types.ts`, `genres.ts` | constante, tipuri, taxonomie |
| `lib/music/access.ts`, `pricing.ts` | `canStream`, `albumPriceUnits`, validare tip |
| `lib/music/repository.ts` | SQL |
| `lib/music/publish.ts` | publicare + sincronizare `audio_tracks` |
| `lib/music/unlock.ts`, `tip.ts` | tranzacții SWYP |
| `app/api/music/**`, `app/api/creator/music/**`, `app/api/admin/music/**` | API |
| `components/music/*` | `MusicPlayerProvider`, `MiniPlayer`, `TrackRow`, `MusicBrand`, `TipSheet` |
| `app/[locale]/music/**`, `app/creator/(dashboard)/music/page.tsx`, `app/admin/music/page.tsx` | pagini |
| `tests/unit/music-*.test.ts` | teste |

---

### Task 1: Refactor comun — `lib/media/*` și `lib/swyp/share.ts`

**Files:**
- Move (git mv): `lib/movies/stream-token.ts` → `lib/media/stream-token.ts`, `lib/movies/stream-path.ts` → `lib/media/stream-path.ts`, `lib/movies/stream-secret.ts` → `lib/media/stream-secret.ts`, `lib/movies/hls-rewrite.ts` → `lib/media/hls-rewrite.ts`
- Create: `lib/swyp/share.ts`
- Modify: importurile din `app/api/movies/[slug]/episodes/[n]/play/route.ts`, `app/api/movies/stream/[token]/[...path]/route.ts`, `lib/movies/pricing.ts`, `tests/unit/movies-stream.test.ts`, `tests/unit/movies-stream-path.test.ts`
- Test: `tests/unit/swyp-share.test.ts`

**Interfaces:**
- Produces: `platformShareUnits(amountUnits: number, ownerUserId: string, viewerUserId: string, shareBps: number): number` — 0 dacă `ownerUserId === SWYPIK_OFFICIAL_ID` sau `ownerUserId === viewerUserId` sau `amountUnits <= 0`; altfel `floor(amount × bps / 10000)`. `creatorShareUnits` din Movies devine un apel către ea (semnătura Movies rămâne).

- [ ] **Step 1: Testul**
```ts
// tests/unit/swyp-share.test.ts
import { describe, it, expect } from "vitest";
import { platformShareUnits } from "@/lib/swyp/share";
import { SWYPIK_OFFICIAL_ID } from "@/lib/config/accounts";

describe("swyp/share", () => {
  it("cota = floor(amount × bps / 10000); 0 pentru contul oficial, self și sume ≤ 0", () => {
    expect(platformShareUnits(500, "owner", "viewer", 7000)).toBe(350);
    expect(platformShareUnits(333, "owner", "viewer", 7000)).toBe(233);
    expect(platformShareUnits(500, SWYPIK_OFFICIAL_ID, "viewer", 7000)).toBe(0);
    expect(platformShareUnits(500, "owner", "owner", 7000)).toBe(0);
    expect(platformShareUnits(0, "owner", "viewer", 7000)).toBe(0);
  });
});
```
- [ ] **Step 2:** `npx vitest run tests/unit/swyp-share.test.ts` → FAIL (modul lipsă).
- [ ] **Step 3: Implementarea + mutarea**
```ts
// lib/swyp/share.ts
import { SWYPIK_OFFICIAL_ID } from "@/lib/config/accounts";
/** Cota unui creator/artist dintr-o plată SWYP. 0 pentru contul oficial (platforma nu se plătește pe sine) și pentru self-plăți (anti-reciclare). */
export function platformShareUnits(amountUnits: number, ownerUserId: string, viewerUserId: string, shareBps: number): number {
    if (amountUnits <= 0) return 0;
    if (ownerUserId === SWYPIK_OFFICIAL_ID || ownerUserId === viewerUserId) return 0;
    return Math.floor((amountUnits * shareBps) / 10_000);
}
```
În `lib/movies/pricing.ts`, corpul lui `creatorShareUnits` devine `return platformShareUnits(amountUnits, ownerUserId, viewerUserId, shareBps);` (import din `@/lib/swyp/share`, șterge importul `SWYPIK_OFFICIAL_ID` dacă rămâne nefolosit).
```bash
mkdir -p lib/media && git mv lib/movies/stream-token.ts lib/media/ && git mv lib/movies/stream-path.ts lib/media/ && git mv lib/movies/stream-secret.ts lib/media/ && git mv lib/movies/hls-rewrite.ts lib/media/
grep -rl "lib/movies/stream-\|lib/movies/hls-rewrite" app lib tests | xargs sed -i 's#@/lib/movies/stream-token#@/lib/media/stream-token#g; s#@/lib/movies/stream-path#@/lib/media/stream-path#g; s#@/lib/movies/stream-secret#@/lib/media/stream-secret#g; s#@/lib/movies/hls-rewrite#@/lib/media/hls-rewrite#g'
```
- [ ] **Step 4:** `npx vitest run tests/unit` → toate PASS (inclusiv `movies-*`); `npx tsc --noEmit --incremental false` → 0.
- [ ] **Step 5: Commit** `refactor(media): helperii de stream în lib/media și cota partajată în lib/swyp/share`

---

### Task 2: Migrare, config, flag, rate-limit, genuri

**Files:**
- Create: `db/migrations/20260922_0001_music.sql`, `lib/music/config.ts`, `lib/music/types.ts`, `lib/music/genres.ts`
- Modify: `lib/feature-flags.ts`, `lib/feature-flags-client.ts` (după `movies`), `lib/security/rate-limit.ts` (după `moviesPublish`), `.env.example`
- Test: `tests/unit/music-genres.test.ts`

**Interfaces:**
- Produces: `MUSIC_GENRES`, `isMusicGenre`, `normalizeMusicGenres`, `musicGenreLabelKey`; constante `MUSIC_*`; tipuri `MusicArtistRow`, `MusicTrackRow`, `MusicAlbumRow`, `TrackDto`, `ArtistDto`, `AlbumDto`, `MusicViewer`; chei rate-limit `musicCatalog`, `musicPlay`, `musicPlays`, `musicUnlock`, `musicTip`, `musicPlaylist`, `musicPublish`, `musicStream`.

- [ ] **Step 1: Test genuri**
```ts
// tests/unit/music-genres.test.ts
import { describe, it, expect } from "vitest";
import { MUSIC_GENRES, isMusicGenre, normalizeMusicGenres, musicGenreLabelKey } from "@/lib/music/genres";
describe("music/genres", () => {
  it("taxonomie fixă cu chei de traducere", () => {
    expect(MUSIC_GENRES).toContain("manele");
    expect(isMusicGenre("pop")).toBe(true);
    expect(isMusicGenre("polka")).toBe(false);
    expect(musicGenreLabelKey("hiphop")).toBe("genre_hiphop");
  });
  it("normalizează: necunoscute afară, fără duplicate, ordine păstrată", () => {
    expect(normalizeMusicGenres(["Pop", "pop", "x", "trap"])).toEqual(["pop", "trap"]);
  });
});
```
- [ ] **Step 2:** rulează → FAIL.
- [ ] **Step 3: Fișierele**
```sql
-- db/migrations/20260922_0001_music.sql
CREATE TABLE IF NOT EXISTS music_artists (
    user_id     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    stage_name  text NOT NULL,
    slug        text NOT NULL UNIQUE,
    bio         text NOT NULL DEFAULT '',
    avatar_url  text,
    cover_url   text,
    approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
    approved_at timestamptz NOT NULL DEFAULT now(),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS music_albums (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    artist_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title          text NOT NULL,
    slug           text NOT NULL UNIQUE,
    cover_url      text,
    release_date   date,
    status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_review','published','archived')),
    price_units    bigint CHECK (price_units IS NULL OR price_units > 0),
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_music_albums_artist ON music_albums (artist_user_id);
CREATE TABLE IF NOT EXISTS music_tracks (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    artist_user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    album_id          uuid REFERENCES music_albums(id) ON DELETE SET NULL,
    track_number      integer CHECK (track_number IS NULL OR track_number > 0),
    title             text NOT NULL,
    slug              text NOT NULL UNIQUE,
    cover_url         text,
    genre             text NOT NULL,
    duration_ms       integer NOT NULL CHECK (duration_ms > 0),
    explicit          boolean NOT NULL DEFAULT false,
    object_key        text NOT NULL,
    public_url        text,
    is_premium        boolean NOT NULL DEFAULT false,
    price_units       bigint CHECK (price_units IS NULL OR price_units > 0),
    allow_reels       boolean NOT NULL DEFAULT true,
    audio_track_id    bigint REFERENCES audio_tracks(id) ON DELETE SET NULL,
    audience          text NOT NULL DEFAULT 'general' CHECK (audience IN ('general','kids')),
    status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_review','published','archived')),
    moderation_status text NOT NULL DEFAULT 'pending_review' CHECK (moderation_status IN ('pending_review','approved','rejected')),
    license_note      text,
    published_at      timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT music_tracks_premium_price CHECK (NOT is_premium OR price_units IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_music_tracks_artist ON music_tracks (artist_user_id);
CREATE INDEX IF NOT EXISTS idx_music_tracks_status_pub ON music_tracks (status, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_music_tracks_genre ON music_tracks (genre) WHERE status = 'published';
CREATE TABLE IF NOT EXISTS music_unlocks (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    track_id           uuid REFERENCES music_tracks(id) ON DELETE CASCADE,
    album_id           uuid REFERENCES music_albums(id) ON DELETE CASCADE,
    units_paid         bigint NOT NULL CHECK (units_paid >= 0),
    artist_share_units bigint NOT NULL DEFAULT 0 CHECK (artist_share_units >= 0),
    ledger_ref         text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT music_unlocks_target CHECK ((track_id IS NOT NULL) <> (album_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_music_unlocks_track ON music_unlocks (user_id, track_id) WHERE track_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_music_unlocks_album ON music_unlocks (user_id, album_id) WHERE album_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS music_tips (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    artist_user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    track_id           uuid REFERENCES music_tracks(id) ON DELETE SET NULL,
    idempotency_key    text NOT NULL,
    units              bigint NOT NULL CHECK (units > 0),
    artist_share_units bigint NOT NULL DEFAULT 0 CHECK (artist_share_units >= 0),
    ledger_ref         text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_music_tips_artist ON music_tips (artist_user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS music_play_counters (
    track_id uuid NOT NULL REFERENCES music_tracks(id) ON DELETE CASCADE,
    day      date NOT NULL,
    plays    integer NOT NULL DEFAULT 0,
    PRIMARY KEY (track_id, day)
);
CREATE TABLE IF NOT EXISTS music_playlists (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title         text NOT NULL,
    is_liked_list boolean NOT NULL DEFAULT false,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_music_liked_list ON music_playlists (user_id) WHERE is_liked_list;
CREATE TABLE IF NOT EXISTS music_playlist_items (
    playlist_id uuid NOT NULL REFERENCES music_playlists(id) ON DELETE CASCADE,
    track_id    uuid NOT NULL REFERENCES music_tracks(id) ON DELETE CASCADE,
    position    integer NOT NULL DEFAULT 0,
    added_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (playlist_id, track_id)
);
```
```ts
// lib/music/config.ts
function intEnv(name: string, fallback: number, min: number, max: number): number {
    const raw = Number(process.env[name]);
    if (!Number.isFinite(raw)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(raw)));
}
export const MUSIC_ARTIST_SHARE_BPS = intEnv("MUSIC_ARTIST_SHARE_BPS", 7000, 0, 10_000);
export const MUSIC_ALBUM_DISCOUNT_PCT = intEnv("MUSIC_ALBUM_DISCOUNT_PCT", 30, 0, 90);
export const MUSIC_TRACK_PRICE_MIN_UNITS = intEnv("MUSIC_TRACK_PRICE_MIN_UNITS", 100, 1, 1_000_000);
export const MUSIC_TRACK_PRICE_MAX_UNITS = intEnv("MUSIC_TRACK_PRICE_MAX_UNITS", 2_000, 1, 1_000_000);
export const MUSIC_DEFAULT_TRACK_PRICE_UNITS = intEnv("MUSIC_DEFAULT_TRACK_PRICE_UNITS", 300, 1, 1_000_000);
/** Presetările de tip (subunități; 100 = 1 SWYP) și plafonul unui tip liber. */
export const MUSIC_TIP_PRESETS_UNITS = [500, 1000, 2500] as const;
export const MUSIC_TIP_MIN_UNITS = 100;
export const MUSIC_TIP_MAX_UNITS = intEnv("MUSIC_TIP_MAX_UNITS", 50_000, 100, 10_000_000);
export const MUSIC_MAX_UPLOAD_BYTES = intEnv("MUSIC_MAX_UPLOAD_MB", 40, 1, 500) * 1024 * 1024;
export const MUSIC_MAX_DURATION_MS = intEnv("MUSIC_MAX_DURATION_MIN", 30, 1, 240) * 60_000;
export const MUSIC_MIN_DURATION_MS = 5_000;
export const MUSIC_STREAM_TOKEN_TTL_S = intEnv("MUSIC_STREAM_TOKEN_TTL_S", 900, 60, 3_600);
export const MUSIC_PLAY_DEDUP_TTL_S = 600;
export const MUSIC_CATALOG_PAGE_SIZE = 30;
export const MUSIC_HOME_ROW_MAX = 20;
export const MUSIC_TOP_COUNT = 10;
export const MUSIC_ALLOWED_MIME = ["audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/aac"] as const;
export const SWYP_UNITS_PER_COIN = 100;
```
```ts
// lib/music/genres.ts
export const MUSIC_GENRES = ["pop", "hiphop", "trap", "manele", "rock", "electronic", "rnb", "latino", "folk", "kids"] as const;
export type MusicGenre = (typeof MUSIC_GENRES)[number];
export function isMusicGenre(v: unknown): v is MusicGenre { return typeof v === "string" && (MUSIC_GENRES as readonly string[]).includes(v); }
export function musicGenreLabelKey(g: MusicGenre): `genre_${MusicGenre}` { return `genre_${g}`; }
export function normalizeMusicGenres(input: readonly string[]): MusicGenre[] {
    const out: MusicGenre[] = [];
    for (const raw of input) { const g = raw.trim().toLowerCase(); if (isMusicGenre(g) && !out.includes(g)) out.push(g); }
    return out;
}
```
```ts
// lib/music/types.ts
export type ContentStatus = "draft" | "pending_review" | "published" | "archived";
export type MusicArtistRow = { user_id: string; stage_name: string; slug: string; bio: string; avatar_url: string | null; cover_url: string | null; approved_at: string; created_at: string; updated_at: string };
export type MusicAlbumRow = { id: string; artist_user_id: string; title: string; slug: string; cover_url: string | null; release_date: string | null; status: ContentStatus; price_units: number | null; created_at: string; updated_at: string };
export type MusicTrackRow = {
    id: string; artist_user_id: string; album_id: string | null; track_number: number | null; title: string; slug: string;
    cover_url: string | null; genre: string; duration_ms: number; explicit: boolean; object_key: string; public_url: string | null;
    is_premium: boolean; price_units: number | null; allow_reels: boolean; audio_track_id: number | null; audience: "general" | "kids";
    status: ContentStatus; moderation_status: "pending_review" | "approved" | "rejected"; license_note: string | null;
    published_at: string | null; created_at: string; updated_at: string;
};
export type MusicViewer = { userId: string | null; isAdmin: boolean; unlockedTrackIds: ReadonlySet<string>; unlockedAlbumIds: ReadonlySet<string> };
export type ArtistDto = { id: string; slug: string; stageName: string; bio: string; avatarUrl: string | null; coverUrl: string | null; isOfficial: boolean };
export type TrackDto = {
    id: string; slug: string; title: string; coverUrl: string | null; genre: string; durationMs: number; explicit: boolean;
    isPremium: boolean; priceUnits: number | null; locked: boolean; allowReels: boolean; audioTrackId: number | null;
    albumId: string | null; trackNumber: number | null; artist: ArtistDto; plays7d: number; liked: boolean;
};
export type AlbumDto = { id: string; slug: string; title: string; coverUrl: string | null; releaseDate: string | null; priceUnits: number | null; locked: boolean; artist: ArtistDto; trackCount: number };
```
Flag-uri: `music: flag('FEATURE_MUSIC', false)` (server, după `movies`) și `music: flag('NEXT_PUBLIC_FEATURE_MUSIC', false)` (client). Rate-limit după `moviesPublish`:
```ts
  musicCatalog: { limit: 60, window: 60 } as RateLimitConfig,
  musicPlay: { limit: 60, window: 60 } as RateLimitConfig,
  musicPlays: { limit: 120, window: 60 } as RateLimitConfig,
  musicUnlock: { limit: 10, window: 60 } as RateLimitConfig,
  musicTip: { limit: 10, window: 60 } as RateLimitConfig,
  musicPlaylist: { limit: 60, window: 60 } as RateLimitConfig,
  musicPublish: { limit: 10, window: 3600 } as RateLimitConfig,
  musicStream: { limit: 300, window: 60 } as RateLimitConfig,
```
`.env.example`: `FEATURE_MUSIC=false`, `NEXT_PUBLIC_FEATURE_MUSIC=false`, `MUSIC_ARTIST_SHARE_BPS=7000`, `MUSIC_ALBUM_DISCOUNT_PCT=30`, `MUSIC_TRACK_PRICE_MIN_UNITS=100`, `MUSIC_TRACK_PRICE_MAX_UNITS=2000`, `MUSIC_DEFAULT_TRACK_PRICE_UNITS=300`, `MUSIC_TIP_MAX_UNITS=50000`, `MUSIC_MAX_UPLOAD_MB=40`, `MUSIC_MAX_DURATION_MIN=30`, `MUSIC_STREAM_TOKEN_TTL_S=900`.
- [ ] **Step 4:** test → PASS; tsc → 0. **Commit** `feat(music): schema, config, flag, genuri`

---

### Task 3: Acces și preț (pure, TDD)

**Files:** Create `lib/music/access.ts`, `lib/music/pricing.ts`; Test `tests/unit/music-access.test.ts`.

**Interfaces:**
- `canStream(viewer: MusicViewer, track: Pick<MusicTrackRow,"id"|"artist_user_id"|"status"|"is_premium"|"album_id">): boolean`
- `albumPriceUnits(album: Pick<MusicAlbumRow,"price_units">, tracks: Pick<MusicTrackRow,"is_premium"|"price_units">[], discountPct?: number): number`
- `clampTrackPrice(units: number): number`, `isValidTipUnits(units: number): boolean`

- [ ] **Step 1: Testul**
```ts
// tests/unit/music-access.test.ts
import { describe, it, expect } from "vitest";
import { canStream } from "@/lib/music/access";
import { albumPriceUnits, clampTrackPrice, isValidTipUnits } from "@/lib/music/pricing";
import { MUSIC_TIP_MAX_UNITS, MUSIC_TRACK_PRICE_MAX_UNITS, MUSIC_TRACK_PRICE_MIN_UNITS } from "@/lib/music/config";
import type { MusicViewer } from "@/lib/music/types";

const viewer = (o: Partial<MusicViewer> = {}): MusicViewer => ({ userId: "u1", isAdmin: false, unlockedTrackIds: new Set(), unlockedAlbumIds: new Set(), ...o });
const free = { id: "t1", artist_user_id: "a1", status: "published" as const, is_premium: false, album_id: null };
const prem = { id: "t2", artist_user_id: "a1", status: "published" as const, is_premium: true, album_id: "al1" };

describe("music/access", () => {
  it("piesele gratuite publicate se ascultă de oricine, cele nepublicate de nimeni (în afară de artist/admin)", () => {
    expect(canStream(viewer({ userId: null }), free)).toBe(true);
    expect(canStream(viewer({ userId: null }), { ...free, status: "draft" })).toBe(false);
    expect(canStream(viewer({ userId: "a1" }), { ...free, status: "draft" })).toBe(true);
    expect(canStream(viewer({ isAdmin: true }), { ...free, status: "draft" })).toBe(true);
  });
  it("premium: doar unlock pe piesă sau pe album, artist sau admin", () => {
    expect(canStream(viewer(), prem)).toBe(false);
    expect(canStream(viewer({ unlockedTrackIds: new Set(["t2"]) }), prem)).toBe(true);
    expect(canStream(viewer({ unlockedAlbumIds: new Set(["al1"]) }), prem)).toBe(true);
    expect(canStream(viewer({ userId: "a1" }), prem)).toBe(true);
  });
});
describe("music/pricing", () => {
  it("prețul albumului: cel setat, altfel suma pieselor premium cu discount", () => {
    const tracks = [{ is_premium: true, price_units: 300 }, { is_premium: true, price_units: 300 }, { is_premium: false, price_units: null }];
    expect(albumPriceUnits({ price_units: 400 }, tracks, 30)).toBe(400);
    expect(albumPriceUnits({ price_units: null }, tracks, 30)).toBe(420);
    expect(albumPriceUnits({ price_units: null }, [{ is_premium: false, price_units: null }], 30)).toBe(0);
  });
  it("limitele de preț și de tip", () => {
    expect(clampTrackPrice(1)).toBe(MUSIC_TRACK_PRICE_MIN_UNITS);
    expect(clampTrackPrice(99_999_999)).toBe(MUSIC_TRACK_PRICE_MAX_UNITS);
    expect(isValidTipUnits(500)).toBe(true);
    expect(isValidTipUnits(50)).toBe(false);
    expect(isValidTipUnits(MUSIC_TIP_MAX_UNITS + 1)).toBe(false);
    expect(isValidTipUnits(150.5)).toBe(false);
  });
});
```
- [ ] **Step 2:** FAIL. **Step 3:**
```ts
// lib/music/access.ts
import type { MusicTrackRow, MusicViewer } from "./types";
export function canStream(viewer: MusicViewer, track: Pick<MusicTrackRow, "id" | "artist_user_id" | "status" | "is_premium" | "album_id">): boolean {
    if (viewer.isAdmin) return true;
    if (viewer.userId && viewer.userId === track.artist_user_id) return true;
    if (track.status !== "published") return false;
    if (!track.is_premium) return true;
    if (viewer.unlockedTrackIds.has(track.id)) return true;
    return Boolean(track.album_id && viewer.unlockedAlbumIds.has(track.album_id));
}
```
```ts
// lib/music/pricing.ts
import { MUSIC_ALBUM_DISCOUNT_PCT, MUSIC_TIP_MAX_UNITS, MUSIC_TIP_MIN_UNITS, MUSIC_TRACK_PRICE_MAX_UNITS, MUSIC_TRACK_PRICE_MIN_UNITS } from "./config";
import type { MusicAlbumRow, MusicTrackRow } from "./types";
export function albumPriceUnits(album: Pick<MusicAlbumRow, "price_units">, tracks: Pick<MusicTrackRow, "is_premium" | "price_units">[], discountPct: number = MUSIC_ALBUM_DISCOUNT_PCT): number {
    if (album.price_units && album.price_units > 0) return Number(album.price_units);
    const sum = tracks.filter((t) => t.is_premium).reduce((s, t) => s + Number(t.price_units ?? 0), 0);
    return sum === 0 ? 0 : Math.round(sum * (1 - discountPct / 100));
}
export function clampTrackPrice(units: number): number {
    const n = Math.trunc(Number(units) || 0);
    return Math.min(MUSIC_TRACK_PRICE_MAX_UNITS, Math.max(MUSIC_TRACK_PRICE_MIN_UNITS, n));
}
export function isValidTipUnits(units: number): boolean {
    return Number.isInteger(units) && units >= MUSIC_TIP_MIN_UNITS && units <= MUSIC_TIP_MAX_UNITS;
}
```
- [ ] **Step 4:** PASS. **Commit** `feat(music): reguli de acces și preț`

---

### Task 4: Repository + publicare (sincronizare `audio_tracks`)

**Files:** Create `lib/music/repository.ts`, `lib/music/publish.ts`, `lib/music/slug.ts`; Test `tests/unit/music-publish.test.ts`.

**Interfaces (repository, toate async):**
- `getArtistBySlug(slug)`, `getArtistByUserId(userId)`, `isArtist(userId): boolean`, `upsertArtist({ userId, stageName, slug, bio, avatarUrl, coverUrl, approvedBy })`
- `getTrackBySlug(slug): Promise<(MusicTrackRow & { artist: MusicArtistRow }) | null>`, `getTrackById(id)`, `listTracks({ genre?, sort:"trending"|"new", q?, limit, offset, artistUserId?, albumId? })` (→ `MusicTrackRow & { artist: MusicArtistRow; plays_7d: number }`), `listTopTracks(limit)`, `listArtistTracks(userId, publishedOnly)`, `listArtistAlbums(userId, publishedOnly)`
- `getAlbumBySlug(slug)`, `createAlbum`, `updateAlbum`
- `createTrack(input)`, `updateTrack(id, artistUserId | null, patch)`, `listTracksForAdmin(status?)`
- `getViewerUnlocks(userId): { trackIds:Set, albumIds:Set }`, `getLikedTrackIds(userId, trackIds[])`
- `incrementPlay(trackId)` (UPSERT pe ziua curentă), `artistEarnings(userId): { tips_units, unlock_units, count }`
- `ensureLikedPlaylist(userId): id`, `listPlaylists(userId)`, `createPlaylist`, `addToPlaylist`, `removeFromPlaylist`, `listPlaylistTracks(playlistId, userId)`
- `publish.ts`: `audioTrackRowFor(track, artist): AudioTrackInsert | null` (pur; `null` pentru premium sau `!allow_reels`), `publishTrack(trackId): Promise<MusicTrackRow | null>` (tranzacție: status→published, published_at, INSERT/UPDATE `audio_tracks`, `audio_track_id`), `syncAudioTrack(q, track, artist)` (pe schimbarea `allow_reels`/premium: `is_active=false` sau reactivare).
- `slug.ts`: `slugifyMusic(text)` (același algoritm ca Movies, prefix `track`/`album`/`artist` fallback).

- [ ] **Step 1: Test (pur)**
```ts
// tests/unit/music-publish.test.ts
import { describe, it, expect } from "vitest";
import { audioTrackRowFor } from "@/lib/music/publish";
const artist = { user_id: "a1", stage_name: "Zara", slug: "zara", bio: "", avatar_url: "https://cdn/a.jpg", cover_url: null, approved_at: "", created_at: "", updated_at: "" };
const base = { id: "t1", title: "Vara", genre: "pop", duration_ms: 183_400, public_url: "https://cdn/music/t1.m4a", cover_url: "https://cdn/c.jpg", is_premium: false, allow_reels: true };
describe("music/publish", () => {
  it("piesa gratuită cu allow_reels devine sunet: source swypik_music, durata în secunde rotunjită, licență artist", () => {
    expect(audioTrackRowFor(base, artist)).toEqual({ source: "swypik_music", source_id: "t1", title: "Vara", artist: "Zara", duration_s: 183, audio_url: "https://cdn/music/t1.m4a", preview_url: null, image_url: "https://cdn/c.jpg", genre: "pop", license: "swypik-artist", attribution_url: "/music/artist/zara", is_active: true });
  });
  it("premium sau fără allow_reels ⇒ niciun sunet public", () => {
    expect(audioTrackRowFor({ ...base, is_premium: true }, artist)).toBeNull();
    expect(audioTrackRowFor({ ...base, allow_reels: false }, artist)).toBeNull();
    expect(audioTrackRowFor({ ...base, public_url: null }, artist)).toBeNull();
  });
});
```
- [ ] **Step 2:** FAIL. **Step 3:** implementează `slug.ts`, `publish.ts` și `repository.ts` (SQL după modelul `lib/movies/repository.ts`: `TRACK_COLS` cu `price_units::text`, normalizare la number; `listTracks` trending = `SUM(plays)` din `music_play_counters` pe 7 zile + unlock-uri + tips; `publishTrack` în `withTransaction`: `UPDATE music_tracks SET status='published', published_at=COALESCE(published_at, now())` dacă `moderation_status='approved'`, apoi `audioTrackRowFor` → `INSERT INTO audio_tracks (...) ON CONFLICT (source, source_id) DO UPDATE SET ... is_active = true RETURNING id` (dacă nu există UNIQUE pe `(source, source_id)`, adaugă-l în migrarea din Task 2: `CREATE UNIQUE INDEX IF NOT EXISTS uq_audio_tracks_source ON audio_tracks (source, source_id)`); când rândul e `null` și există `audio_track_id` → `UPDATE audio_tracks SET is_active=false`).
- [ ] **Step 4:** PASS; tsc 0. **Commit** `feat(music): repository, publicare și sincronizarea sunetelor pentru reels`

---

### Task 5: Unlock și tip (tranzacții SWYP, TDD cu DB mock)

**Files:** Create `lib/music/unlock.ts`, `lib/music/tip.ts`; Test `tests/unit/music-money.test.ts`.

**Interfaces:**
- `unlockTrack({ userId, trackId })`, `unlockAlbum({ userId, albumId })` → `UnlockResult` (aceeași formă ca Movies: `ok/alreadyApplied/unitsPaid/artistShareUnits` | `reason: not_found|not_premium|not_published|insufficient_balance`); refId `music_unlock:<userId>:track:<id>` / `:album:<id>`; `kind:"spend"`, `refType:"music_unlock"`; cotă `kind:"reward"`, `refType:"music_artist_share"`.
- `tipArtist({ userId, artistUserId, trackId, units, idempotencyKey })` → `{ ok:true, alreadyApplied, units, artistShareUnits } | { ok:false, reason: invalid_units|artist_not_found|insufficient_balance }`; refId `music_tip:<userId>:<idempotencyKey>`; INSERT `music_tips ... ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING id` ÎNAINTE de transferuri.

- [ ] **Step 1: Testul** (mock `@/lib/db` + `@/lib/swyp/ledger` exact ca în `tests/unit/movies-unlock.test.ts`; SQL-urile recunoscute după prefix: `FROM music_tracks t` + `JOIN music_artists`, `INSERT INTO music_unlocks`, `UPDATE music_unlocks`, `FROM music_albums`, `INSERT INTO music_tips`, `UPDATE music_tips`, `SELECT 1 FROM music_artists`). Cazuri: unlock piesă premium 300 → spend 300n + reward 210n; dublu-tap → `alreadyApplied`, 0 transferuri; sold insuficient → `insufficient_balance`; piesă gratuită → `not_premium`; tip 1000 → spend 1000n + reward 700n; tip cu același `idempotencyKey` a doua oară → `alreadyApplied`, 0 transferuri; self-tip → un singur transfer (spend), cotă 0; tip 50 → `invalid_units`.
- [ ] **Step 2:** FAIL. **Step 3:** implementare pe tiparul `lib/movies/unlock.ts` (`settle` cu INSERT-guard → spend → share → UPDATE), `platformShareUnits(..., MUSIC_ARTIST_SHARE_BPS)`.
- [ ] **Step 4:** PASS. **Commit** `feat(music): deblocare piese/albume și tip pentru artiști, idempotente`

---

### Task 1 (completare): generalizarea token-ului și a prefixului de proxy

Odată mutate în `lib/media/`, helperii primesc două generalizări mici (Movies rămâne verde):
- `stream-token.ts`: `StreamTokenPayload = { userId: string; scope: "movies" | "music"; mediaId: string; expiresAt: number }`; `verifyStreamToken(token, secret, now?)` validează și `scope`. Movies: `signStreamToken({ userId, scope: "movies", mediaId: episode.id, expiresAt }, …)`; proxy-ul Movies refuză `payload.scope !== "movies"` și citește `payload.mediaId`. Actualizează `tests/unit/movies-stream.test.ts` la noul payload.
- `stream-path.ts`: `toProxyPath(token, absoluteUrl, playbackUrl, prefix = STREAM_ROUTE_PREFIX)`; adaugă `export const MUSIC_STREAM_ROUTE_PREFIX = "/api/music/stream"`. Numele `episodeMediaDir`/`resolveEpisodeMediaUrl` rămân (fără redenumiri în acest task).

---

### Task 6: Citire publică — DTO, home, play, proxy, contor de plays

**Files:**
- Create: `lib/music/dto.ts`, `lib/music/viewer.ts`, `lib/music/home.ts`, `lib/music/plays.ts`
- Create: `app/api/music/home/route.ts`, `app/api/music/tracks/route.ts`, `app/api/music/tracks/[slug]/route.ts`, `app/api/music/tracks/[slug]/play/route.ts`, `app/api/music/stream/[token]/[...path]/route.ts`, `app/api/music/plays/route.ts`, `app/api/music/artists/[slug]/route.ts`, `app/api/music/albums/[slug]/route.ts`
- Test: `tests/unit/music-home.test.ts`, `tests/unit/music-plays.test.ts`

**Interfaces:**
- `toArtistDto(a: MusicArtistRow): ArtistDto` (`isOfficial = a.user_id === SWYPIK_OFFICIAL_ID`), `toTrackDto(t: MusicTrackRow & { plays_7d?: number }, artist, viewer, liked: boolean): TrackDto` (`locked = !canStream(viewer, t)`), `toAlbumDto(album, artist, tracks, viewer)` (`locked = album are piese premium ∧ !unlockedAlbumIds.has(id)`).
- `buildMusicViewer(userId, isAdmin): Promise<MusicViewer>` (unlocks din repository; anonim ⇒ seturi goale).
- `buildMusicHomeRows({ top, latest, liked, playlists })` → `MusicHomeRow[]`: `top10` (max `MUSIC_TOP_COUNT`) → `originals` (artist oficial) → `latest` → `liked` (dacă există) → câte un rând `genre` cu conținut, ordinea genurilor = prima apariție în `top`, apoi `MUSIC_GENRES`; rândurile goale lipsesc.
- `playDedupKey(ip, trackId)` = `music:play:<ip>:<trackId>`; `shouldCountPlay(client: { set(key, value, mode: "EX", ttl: number, flag: "NX"): Promise<unknown> }, ip, trackId, ttlS = MUSIC_PLAY_DEDUP_TTL_S): Promise<boolean>` — `true` doar când SET NX întoarce `"OK"`.

- [ ] **Step 1: Testele**
```ts
// tests/unit/music-home.test.ts
import { describe, it, expect } from "vitest";
import { buildMusicHomeRows } from "@/lib/music/home";
import type { TrackDto } from "@/lib/music/types";
const track = (id: string, genre: string, official = false): TrackDto => ({
  id, slug: id, title: id, coverUrl: null, genre, durationMs: 1000, explicit: false, isPremium: false, priceUnits: null, locked: false,
  allowReels: true, audioTrackId: null, albumId: null, trackNumber: null, plays7d: 0, liked: false,
  artist: { id: "a", slug: "a", stageName: "A", bio: "", avatarUrl: null, coverUrl: null, isOfficial: official },
});
describe("music/home", () => {
  it("top10 → originals → latest → liked → genuri în ordinea din top; fără rânduri goale", () => {
    const top = [track("1", "pop", true), track("2", "trap"), track("3", "pop")];
    const rows = buildMusicHomeRows({ top, latest: [track("3", "pop")], liked: [track("2", "trap")], playlists: [] });
    expect(rows.map((r) => r.kind)).toEqual(["top10", "originals", "latest", "liked", "genre", "genre"]);
    expect(rows.filter((r) => r.kind === "genre").map((r) => r.kind === "genre" && r.genre)).toEqual(["pop", "trap"]);
    expect(rows.find((r) => r.kind === "originals")?.items.map((t) => t.id)).toEqual(["1"]);
  });
  it("fără date ⇒ niciun rând", () => {
    expect(buildMusicHomeRows({ top: [], latest: [], liked: [], playlists: [] })).toEqual([]);
  });
});
```
```ts
// tests/unit/music-plays.test.ts
import { describe, it, expect, vi } from "vitest";
import { playDedupKey, shouldCountPlay } from "@/lib/music/plays";
describe("music/plays", () => {
  it("un play per (IP, piesă) în fereastra de dedup: doar primul SET NX contează", async () => {
    const seen = new Set<string>();
    const client = { set: vi.fn(async (key: string) => (seen.has(key) ? null : (seen.add(key), "OK"))) };
    expect(playDedupKey("1.2.3.4", "t1")).toBe("music:play:1.2.3.4:t1");
    expect(await shouldCountPlay(client, "1.2.3.4", "t1")).toBe(true);
    expect(await shouldCountPlay(client, "1.2.3.4", "t1")).toBe(false);
    expect(await shouldCountPlay(client, "1.2.3.4", "t2")).toBe(true);
    expect(client.set).toHaveBeenLastCalledWith("music:play:1.2.3.4:t2", "1", "EX", 600, "NX");
  });
});
```
- [ ] **Step 2:** FAIL. **Step 3:** implementează modulele pure, apoi rutele pe tiparul Movies:
  - `GET /api/music/home`: `rateLimit("musicCatalog", getClientIP(req))`; `Promise.all([listTracks({sort:"trending", limit: 60}), listTracks({sort:"new", limit: MUSIC_HOME_ROW_MAX}), user ? listPlaylistTracks(likedListId) : [], user ? listPlaylists(user) : []])`; răspuns `{ featured: top[0] ?? null, rows }`.
  - `GET /api/music/tracks?genre=&sort=&q=&offset=`: zod pe query (`genre: z.enum(MUSIC_GENRES).optional()`, `sort: z.enum(["trending","new"]).default("trending")`, `q: z.string().trim().max(80).optional()`), `limit = MUSIC_CATALOG_PAGE_SIZE`.
  - `GET /api/music/tracks/[slug]` → `{ track, album?: AlbumDto, viewer: { balanceUnits, requireAuth } }`; 404 dacă nepublicată și viewer-ul nu e artist/admin.
  - `GET /api/music/tracks/[slug]/play`: `rateLimit("musicPlay", getClientIP(req))`; dacă `!canStream` → 402 `{ error:"locked", priceUnits, albumPriceUnits: album ? albumPriceUnits(album, albumTracks) : null, balanceUnits, requireAuth }`; gratuit → `{ url: public_url, expiresAt: null }`; premium → token `{ userId: user.userId ?? "admin", scope:"music", mediaId: track.id, expiresAt }`, `url = ${MUSIC_STREAM_ROUTE_PREFIX}/${token}/${mediaBasename(getVideoAssetUrl(track.object_key))}`.
  - `GET /api/music/stream/[token]/[...path]`: copie a proxy-ului Movies: `verifyStreamToken` + `scope === "music"`, `rateLimit("musicStream", …)`, `getTrackById(payload.mediaId)`, `resolveEpisodeMediaUrl(getVideoAssetUrl(track.object_key), path.join("/"))`, header `range` trecut mai departe, `cache-control: private, max-age=300`; fără ramura HLS (MVP progresiv) — dar folosește totuși `rewriteHlsPlaylist` dacă content-type e playlist, ca să nu se strice când vine worker-ul audio.
  - `POST /api/music/plays` `{ trackId: uuid }`: `rateLimit("musicPlays", ip)`; `shouldCountPlay(getRedis(), ip, trackId)` (dacă Redis aruncă ⇒ log + numără); `incrementPlay(trackId)`; 204.
  - `GET /api/music/artists/[slug]` → `{ artist, tracks: TrackDto[], albums: AlbumDto[], reelsCount }` (`reelsCount = COUNT(videos) WHERE audio_track_id IN (…)` — dacă `videos` nu are `audio_track_id`, întoarce 0 și lasă un comentariu). `GET /api/music/albums/[slug]` → `{ album, tracks }`.
- [ ] **Step 4:** teste PASS; tsc 0. **Commit** `feat(music): API de citire, redare cu token și contor de plays`

---

### Task 7: Bani și liste — unlock, tip, like, playlist-uri (API)

**Files:**
- Create: `app/api/music/tracks/[slug]/unlock/route.ts`, `app/api/music/albums/[slug]/unlock/route.ts`, `app/api/music/tips/route.ts`, `app/api/music/tracks/[slug]/like/route.ts`, `app/api/music/playlists/route.ts`, `app/api/music/playlists/[id]/route.ts`, `app/api/music/playlists/[id]/items/route.ts`

**Interfaces:**
- Unlock: `POST`, 401 fără user, `rateLimit("musicUnlock", userId)`, corp gol; `FAILURE_STATUS = { not_found: 404, not_premium: 409, not_published: 404, insufficient_balance: 402 }`; răspuns `{ ...result, balanceUnits }`.
- Tips: `POST /api/music/tips` `{ artistSlug: string, trackSlug?: string, units: number, idempotencyKey: uuid }`; `units` validat cu `isValidTipUnits`; `rateLimit("musicTip", userId)`; `FAILURE_STATUS = { invalid_units: 400, artist_not_found: 404, insufficient_balance: 402 }`.
- Like: `POST` adaugă în lista „Îmi plac" (`ensureLikedPlaylist` + `addToPlaylist`), `DELETE` scoate; 204.
- Playlists: `GET` (ale user-ului, cu `trackCount`), `POST { title }` (max 80), `[id]`: `PATCH { title }`, `DELETE`; `[id]/items`: `POST { trackId }`, `DELETE { trackId }`; toate 403 dacă playlist-ul nu e al user-ului; `rateLimit("musicPlaylist", userId)`.

- [ ] **Step 1:** scrie rutele (fără test nou — logica de bani e testată în Task 5; rutele sunt straturi subțiri).
- [ ] **Step 2:** `npx tsc --noEmit --incremental false` → 0; `npx eslint app/api/music`.
- [ ] **Step 3: Commit** `feat(music): API pentru deblocare, tip, like și playlist-uri`

---

### Task 8: Studio artist — upload direct pe R2 și API-ul creatorului

**Files:**
- Modify: `lib/storage/video-storage.ts` (export nou `createPresignedPutUrl(key, contentType)`; `createVideoUploadUrl` îl folosește)
- Create: `lib/storage/media-upload.ts`, `app/api/creator/music/route.ts`, `app/api/creator/music/upload-url/route.ts`, `app/api/creator/music/tracks/route.ts`, `app/api/creator/music/tracks/[id]/route.ts`, `app/api/creator/music/albums/route.ts`
- Test: `tests/unit/media-upload.test.ts`

**Interfaces:**
- `buildMusicObjectKey(artistUserId, trackId, filename): string` → `music/raw/<artist>/<trackId>/<safe filename>` (aceleași sanitizări ca `buildRawVideoObjectKey`; extensia păstrată doar dacă e `.mp3|.m4a|.aac`, altfel `.m4a`).
- `isOwnedMusicKey(key, artistUserId): boolean` — `key.startsWith(\`music/raw/${sanitize(artistUserId)}/\`)` și fără `..`.
- `createAudioUploadUrl({ artistUserId, trackId, filename, contentType })` → `{ url, key, expiresIn }`; `contentType` trebuie să fie în `MUSIC_ALLOWED_MIME`.
- `GET /api/creator/music` → `{ artist: MusicArtistRow | null, tracks, albums, earnings }` (`artistEarnings`).
- `POST /api/creator/music/upload-url` `{ filename, contentType, sizeBytes }` → 403 dacă nu e artist, 400 dacă MIME/size invalide, altfel `{ trackId: randomUUID(), url, key, expiresIn }`.
- `POST /api/creator/music/tracks` `{ trackId, objectKey, title, genre, durationMs, explicit, isPremium, priceUnits?, allowReels, audience, albumId?, trackNumber?, coverUrl?, licenseNote }`: `isOwnedMusicKey`; `durationMs` în `[MUSIC_MIN_DURATION_MS, MUSIC_MAX_DURATION_MS]`; premium ⇒ `price_units = clampTrackPrice(priceUnits ?? MUSIC_DEFAULT_TRACK_PRICE_UNITS)`, `public_url = null`; gratuit ⇒ `public_url = getVideoAssetUrl(objectKey)`; `status='pending_review'`; `licenseNote` obligatoriu (min 10). `rateLimit("musicPublish", userId)`.
- `PATCH /api/creator/music/tracks/[id]`: câmpuri editabile (title, genre, explicit, isPremium/priceUnits, allowReels, audience, coverUrl, albumId, trackNumber, `status: "archived"`); la schimbarea `isPremium`/`allowReels` pe o piesă publicată ⇒ `syncAudioTrack` în aceeași tranzacție (premium ⇒ `public_url = null`, sunet dezactivat).
- `GET/POST /api/creator/music/albums` (`POST { title, coverUrl?, releaseDate?, priceUnits? }`).

- [ ] **Step 1: Testul**
```ts
// tests/unit/media-upload.test.ts
import { describe, it, expect } from "vitest";
import { buildMusicObjectKey, isOwnedMusicKey } from "@/lib/storage/media-upload";
describe("storage/media-upload", () => {
  it("cheia stă sub music/raw/<artist>/<track>/ și păstrează doar extensiile audio permise", () => {
    expect(buildMusicObjectKey("a1", "t1", "Vara 2026.mp3")).toBe("music/raw/a1/t1/Vara-2026.mp3");
    expect(buildMusicObjectKey("a1", "t1", "x.exe")).toBe("music/raw/a1/t1/x.m4a");
    expect(buildMusicObjectKey("../a1", "t1", "x.m4a").startsWith("music/raw/")).toBe(true);
  });
  it("un artist nu poate înregistra chei din alt prefix", () => {
    expect(isOwnedMusicKey("music/raw/a1/t1/x.m4a", "a1")).toBe(true);
    expect(isOwnedMusicKey("music/raw/a2/t1/x.m4a", "a1")).toBe(false);
    expect(isOwnedMusicKey("videos/raw/a1/t1/x.m4a", "a1")).toBe(false);
    expect(isOwnedMusicKey("music/raw/a1/../a2/x.m4a", "a1")).toBe(false);
  });
});
```
- [ ] **Step 2:** FAIL. **Step 3:** implementează; **Step 4:** PASS, tsc 0. **Commit** `feat(music): upload direct pe R2 și API-ul studioului de artist`

---

### Task 9: Admin — artiști și review

**Files:** Create `app/api/admin/music/artists/route.ts` (`GET` listă cu `display_name/email`; `POST { userId, stageName, bio? }` → `upsertArtist` cu `slug = slugifyMusic(stageName)`, `approvedBy = auth.userId`; `DELETE { userId }` → șterge rândul și arhivează piesele), `app/api/admin/music/tracks/route.ts` (`GET ?status=` → `listTracksForAdmin`), `app/api/admin/music/tracks/[id]/route.ts` (`PATCH { action: "approve" | "reject" | "publish" | "archive", note? }`: `approve` ⇒ `moderation_status='approved'`; `publish` ⇒ `publishTrack(id)` (409 dacă nu e approved); `archive` ⇒ `status='archived'` + `syncAudioTrack` dezactivare).

- [ ] **Step 1:** rute cu `requireAuth(req, ["admin"])` ca la `app/api/admin/movies/publishers/route.ts`.
- [ ] **Step 2:** tsc 0, eslint. **Commit** `feat(music): API admin pentru artiști și review`

---

### Task 10: Mini-player persistent și componentele Music

**Files:**
- Create: `components/music/MusicPlayerProvider.tsx`, `components/music/MiniPlayer.tsx`, `components/music/MusicBrand.tsx`, `components/music/TrackRow.tsx`, `components/music/TipSheet.tsx`, `components/music/MusicPaywall.tsx`, `components/music/GenreChips.tsx`, `components/music/format.ts` (`formatDuration(ms)`, `unitsToSwyp` re-export din Movies)
- Modify: `app/layout.tsx` (înfășoară conținutul în `<MusicPlayerProvider>` și randează `<MiniPlayer />` imediat înainte de `<BottomNav />`)

**Interfaces:**
- `useMusicPlayer()` → `{ current: TrackDto | null, queue: TrackDto[], index, playing, positionMs, durationMs, play(tracks: TrackDto[], index = 0), toggle(), next(), prev(), seek(ms), close(), locked: { track: TrackDto; priceUnits; albumPriceUnits; balanceUnits; requireAuth } | null, dismissLocked() }`.
- Provider: dacă `!isEnabledClient("music")` întoarce doar `children` (context cu no-op-uri). Un singur `<audio>`; la `play` cere `GET /api/music/tracks/<slug>/play` → 200 setează `src`; 402 setează `locked` (paywall-ul îl afișează) și sare la următoarea; `onended` → `next()`; `onerror` → recere URL-ul o dată (token expirat) apoi `next()`. `navigator.mediaSession` (metadata + handlers play/pause/next/prev) când există. `POST /api/music/plays` o singură dată per redare, când `currentTime ≥ 30 s` sau la `ended` dacă piesa e mai scurtă.
- `MiniPlayer`: bară fixă (`bottom` = înălțimea BottomNav când e vizibil, altfel `env(safe-area-inset-bottom)`), copertă, titlu/artist (link la `/music/track/<slug>`), play/pause, next, progres subțire; ascuns pe `/go`, `/movies/*/*` (player-ul Movies), `/kids`, `/checkout`; `aria-label`-uri din `t("music")`.
- `MusicBrand`: „SWYPIK" alb + „MUSIC" `#7C3AED` cu glow violet, același `MOVIES_DISPLAY_CLASS` (fontul se importă din `components/movies/fonts`).
- `TrackRow`: rând listă (copertă 48px, titlu, artist, durată, badge `premium`/`explicit`, buton play, meniu: like, + playlist, folosește în reel → `/upload?audio=<audioTrackId>` doar dacă `audioTrackId`).
- `TipSheet`: bottom-sheet cu 3 presetări din `MUSIC_TIP_PRESETS_UNITS` + sumă liberă (SWYP), `idempotencyKey = crypto.randomUUID()` generat la deschidere și refolosit la retry; afișează soldul și eroarea `insufficient`.
- `MusicPaywall`: preț piesă / album, buton deblocare (`POST unlock`), apoi `play` din nou.

- [ ] **Step 1:** implementează componentele (client), fără text hardcodat (namespace `music`).
- [ ] **Step 2:** `npx tsc --noEmit --incremental false` → 0; `npx eslint components/music app/layout.tsx`.
- [ ] **Step 3: Commit** `feat(music): mini-player persistent și componentele de bază`

---

### Task 11: Paginile publice `/music`

**Files:** Create `app/[locale]/music/page.tsx` + `MusicClient.tsx`, `app/[locale]/music/artist/[slug]/page.tsx` + `ArtistClient.tsx`, `app/[locale]/music/track/[slug]/page.tsx` + `TrackClient.tsx`, `app/[locale]/music/album/[slug]/page.tsx` + `AlbumClient.tsx`.

- `page.tsx`: `generateMetadata` din `meta.musicTitle/musicDescription`; `if (!isEnabled("music")) notFound()`; `dynamic = "force-dynamic"`.
- `MusicClient`: fundal `#0B0B12` → negru, header fix cu `MusicBrand` + `GenreChips` (`MUSIC_GENRES`, chip → `/api/music/tracks?genre=`), hero = `featured` (copertă blur pe fundal, titlu cu fontul de afișare, artist, buton Play care pune tot Top 10 în coadă), rânduri: Top 10 cu cifre mari conturate (aceeași tehnică `WebkitTextStroke` ca `TopTenCard`), Originals, Noutăți, Îmi plac, playlist-uri, genuri; stări `loading`/`empty`/`loadError`.
- `ArtistClient`: cover, avatar, nume, bio, **Susține** (`TipSheet`), butoane Play all / Shuffle, albume (grilă), piese (`TrackRow`), „Sunete pentru reels: N clipuri".
- `TrackClient`: copertă mare, titlu, artist (link), Play, Like, + Playlist, Susține, „Folosește în reel", paywall dacă `locked`; album-ul din care face parte (listă).
- `AlbumClient`: copertă, titlu, artist, preț album + deblocare, piese.
- BottomNav rămâne vizibil pe `/music` (mini-player-ul stă deasupra lui).

- [ ] **Step 1:** pagini + clienți. **Step 2:** tsc 0, eslint, `node scripts/i18n-guard.mjs` (după Task 13 cheile există; până atunci folosește cheile din lista de mai jos și adaugă-le în Task 13).
- [ ] **Step 3: Commit** `feat(music): paginile /music, artist, piesă, album`

---

### Task 12: Studio artist, admin și navigație

**Files:** Create `app/creator/(dashboard)/music/page.tsx`, `app/admin/music/page.tsx`; Modify `app/creator/(dashboard)/layout.tsx` (după `/creator/movies`: `{ href: "/creator/music", icon: "music", label: t("music") }` — dacă `icon` e o cheie dintr-un map de icoane, adaugă `music: Music` din lucide), `app/admin/AdminShell.tsx` (după Movies: `{ href: "/admin/music", label: "Music", icon: Music }`), `components/home/CategorySidebar.tsx` (după intrarea `movies`: `id:"music", brand:"Swypik Music", label:"Independent artists", badge:"Nou", badgeColor:"bg-violet-600 text-white", accent:"#7C3AED", Icon: Music, href:"/music"` — la fel ca celelalte verticale, etichetele acestei liste sunt încă hardcodate; notat ca datorie).

- `/creator/music`: dacă `artist === null` → mesaj `notArtist` (cum devine artist: cerere către admin); altfel: câștiguri (tips + unlock-uri în SWYP), formular piesă nouă: fișier (`accept="audio/mpeg,audio/mp4,audio/x-m4a,audio/aac"`), durata citită cu `<audio>` din `URL.createObjectURL`, `POST upload-url` → `XMLHttpRequest` PUT cu progres → `POST tracks`; câmpuri: titlu, gen (chip-uri `MUSIC_GENRES`), explicit, premium + preț SWYP, permite în reels, audiență (general/kids), album (select), licență (textarea obligatorie); lista pieselor cu status și acțiuni (editează, arhivează). Albume: creare simplă.
- `/admin/music`: două tab-uri: Artiști (listă + formular aprobare `userId`, `stageName`; ștergere) și Piese (filtru status; butoane approve / reject / publish / archive; preview audio pentru piesele gratuite prin `public_url`, pentru premium prin `play` ca admin).

- [ ] **Step 1:** pagini + nav. **Step 2:** tsc 0, eslint. **Commit** `feat(music): studio artist, admin și intrările din meniu`

---

### Task 13: i18n ×7, documentație, gate-uri finale

**Files:** Modify `messages/{ro,en,es,fr,de,pt,it}.json`, `CLAUDE.md` (rând în tabelul de flag-uri + `app/music/`, `lib/music/`, `lib/media/` în structură), `.env.example`; Create `docs/deploy/2026-09-22-music-release.md`.

Namespace `music` (aceleași chei în toate cele 7 fișiere; RO ca sursă, restul traduse natural, nu copiate):
`title, tagline, back, play, pause, next, previous, playAll, shuffle, nowPlaying, close, top10, originals, newReleases, liked, myPlaylists, forYou, all, genre_pop, genre_hiphop, genre_trap, genre_manele, genre_rock, genre_electronic, genre_rnb, genre_latino, genre_folk, genre_kids, premium, explicit, free, locked, priceSwyp, albumPriceSwyp, unlockTrack, unlockAlbum, unlocking, unlocked, yourBalance, insufficient, loginToUnlock, loginToTip, support, tipTitle, tipPresets, tipCustom, tipSend, tipSent, tipError, like, unlike, addToPlaylist, removeFromPlaylist, newPlaylist, playlistName, useInReel, reelsUsing, tracks, albums, discography, about, official, by, empty, emptyGenre, loadError, loading, studio, studioIntro, notArtist, earnings, earningsTips, earningsUnlocks, newTrack, upload, uploading, uploadDone, uploadError, fileTooLarge, fileType, durationLabel, trackTitle, coverUrl, isPremium, priceLabel, allowReels, audience, audienceGeneral, audienceKids, album, noAlbum, trackNumber, licenseNote, licenseHint, submitReview, statusDraft, statusPendingReview, statusPublished, statusArchived, archive, edit, save, cancel, error, admin, artists, artistsIntro, approveArtist, stageName, bio, remove, review, approve, reject, publish, minutes, seconds, explicitBadge, sidebarLabel`.
Alte chei: `meta.musicTitle`, `meta.musicDescription`, `creatordashboard.music`.

- [ ] **Step 1:** adaugă cheile în RO, apoi în celelalte 6 (script node care verifică egalitatea seturilor de chei cu `scripts/i18n-guard.mjs`).
- [ ] **Step 2:** `node scripts/i18n-guard.mjs` → verde; `npx tsc --noEmit --incremental false`; `npx vitest run`; `npx next lint`; `npx next build`.
- [ ] **Step 3:** runbook de deploy (backup, `FEATURE_MUSIC=1` + `NEXT_PUBLIC_FEATURE_MUSIC=1` în `.env.production`, `bash infra/hetzner/deploy.sh`, migrarea `20260922_0001_music.sql` aplicată de deploy.sh, smoke: `GET /api/music/home` → 200, `GET /music` → 200, aprobarea contului oficial ca artist, prima piesă, rollback).
- [ ] **Step 4: Commit** `feat(music): traduceri, documentație și runbook de lansare`

---

## Verificare finală (înainte de merge)

1. `npx tsc --noEmit --incremental false` → 0 erori.
2. `npx vitest run` → toate verzi (Movies + Music).
3. `npx next lint` → 0 erori; `npx next build` → OK.
4. `node scripts/i18n-guard.mjs` → verde.
5. Review final (subagent) pe Review Focus 1–5 + diff complet; apoi `superpowers:finishing-a-development-branch`.
