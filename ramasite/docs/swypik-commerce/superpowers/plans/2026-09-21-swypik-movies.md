# Swypik Movies — plan de implementare

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un vertical „Swypik Movies": micro-seriale verticale cu episoade în `videos`, primele N episoade gratuite, restul deblocate cu SWYP, creatorul primind instant o cotă din fiecare deblocare; catalog cinematic, player cu paywall real, episoadele gratuite în feed, intrare în hamburger, totul după `FEATURE_MOVIES`.

**Architecture:** Tabele proprii (`movie_publishers`, `movie_series`, `movie_episodes`, `movie_unlocks`, `movie_watch_progress`), fiecare episod referind un rând `videos` deja transcodat. Regulile de acces/preț sunt funcții pure în `lib/movies/*` (testate cu vitest), banii trec exclusiv prin `swypTransferInTx` într-o singură tranzacție, iar episoadele blocate se servesc printr-un proxy HLS cu token HMAC expirabil.

**Tech Stack:** Next.js 15 App Router, TypeScript strict, PostgreSQL (`lib/db.ts`, SQL brut), zod, next-intl (7 locale), vitest, hls.js prin `lib/video/useHlsVideo`, ledger SWYP `lib/swyp/ledger.ts`.

**Spec:** `docs/superpowers/specs/2026-09-21-swypik-movies-design.md`

## Global Constraints

- Toate textele UI prin `next-intl`; fiecare cheie nouă în TOATE cele 7 fișiere `messages/{ro,en,es,fr,de,pt,it}.json` (pre-commit `scripts/i18n-guard.mjs` blochează altfel).
- Zero `any` nou; erorile către client sunt coduri (`"internal_error"`, `"locked"`), niciodată `error.message`.
- Toate rutele API: `withErrorHandling` din `lib/api-handler.ts`, `parseBody` + zod din `lib/validation/schemas.ts`, `rateLimit` din `lib/security/rate-limit.ts`.
- Numere magice doar în `lib/movies/config.ts` (citite din env cu fallback explicit).
- Flag: `FEATURE_MOVIES` (server) + `NEXT_PUBLIC_FEATURE_MOVIES` (client), implicit OFF; rute → `frozenResponse("movies")` (410), pagini → `notFound()`.
- Migrări idempotente (`IF NOT EXISTS`), nume `YYYYMMDD_NNNN_*.sql`, în `db/migrations/`.
- Comenzi rulate din `E:\Swypik\swypik\app` (Git Bash: `cd /e/Swypik/swypik/app`). Gate-uri: `npx tsc --noEmit --incremental false`, `npx vitest run`, `npx eslint <fișiere>`, la final `npx next build`.
- Commit-uri mici, mesaje în română, cu `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. **Deblocare concurentă (dublu-tap):** două POST-uri simultane pe același episod trebuie să debiteze o singură dată — pinned în Task 5 (`refId` determinist + UNIQUE + `alreadyApplied`).
2. **Owner care își deblochează propriul episod:** nu primește cotă (altfel „spală" SWYP prin pool) — pinned în Task 2 (`creatorShareUnits` → 0).
3. **`free_episodes` scade după ce episoade erau publice:** episoadele devenite blocate trebuie să dispară din feed/căutare — pinned în Task 4 (`syncEpisodeVisibility` setează `private`).
4. **Token de stream reutilizat de alt user / după expirare / pe alt episod:** 403 — pinned în Task 3 (`verifyStreamToken`) și Task 6 (proxy compară `episodeId`).
5. **Proxy folosit ca SSRF:** parametrul `p` trebuie să aparțină originii media configurate — pinned în Task 6 (`isAllowedMediaUrl`).

---

## Structura fișierelor

| Fișier | Responsabilitate |
|---|---|
| `db/migrations/20260921_0003_movies.sql` | cele 5 tabele + indexuri |
| `lib/movies/config.ts` | constante din env (cotă, discount, limite preț, TTL token) |
| `lib/movies/types.ts` | tipuri de rând și DTO-uri publice |
| `lib/movies/access.ts` | `isFreeEpisode`, `canPlay` (pure) |
| `lib/movies/pricing.ts` | `seasonPriceUnits`, `creatorShareUnits`, `clampEpisodePrice` (pure) |
| `lib/movies/stream-token.ts` | HMAC sign/verify (pure) |
| `lib/movies/hls-rewrite.ts` | rescrierea playlist-urilor HLS către proxy (pure) |
| `lib/movies/repository.ts` | toate interogările SQL Movies |
| `lib/movies/visibility.ts` | sincronizarea `videos.visibility` cu starea gratuit/blocat |
| `lib/movies/unlock.ts` | tranzacția de deblocare (spend + cotă creator + rând unlock) |
| `app/api/movies/**` | API public (catalog, serial, play, unlock, progress, stream) |
| `app/api/creator/movies/**` | studio creator |
| `app/api/admin/movies/**` | admin (publisheri, review, publicare) |
| `app/[locale]/movies/**` | pagini: catalog cinematic, serial, player |
| `app/creator/(dashboard)/movies/page.tsx` | Creator Studio Movies |
| `app/admin/movies/page.tsx` | Admin Movies |
| `components/movies/*` | `MovieEpisodeBadge` (feed), `PaywallSlide`, `PosterCard` |
| `tests/unit/movies-*.test.ts` | teste pentru fiecare modul pur + unlock cu DB mock |

---

### Task 1: Migrare, config, flag, rate-limit

**Files:**
- Create: `db/migrations/20260921_0003_movies.sql`
- Create: `lib/movies/config.ts`
- Create: `lib/movies/types.ts`
- Modify: `lib/feature-flags.ts` (după linia `squadBuy: flag('FEATURE_SQUAD_BUY', false),`)
- Modify: `lib/feature-flags-client.ts` (după linia `squadBuy: flag('NEXT_PUBLIC_FEATURE_SQUAD_BUY', false),`)
- Modify: `lib/security/rate-limit.ts` (după linia `mysteryDrop: { limit: 5, window: 60 } as RateLimitConfig,`)
- Modify: `.env.example` (la final)

**Interfaces:**
- Produces: `MOVIES_*` constante; tipurile `MovieSeriesRow`, `MovieEpisodeRow`, `MovieUnlockRow`, `MovieProgressRow`, `SeriesStatus`, `EpisodeStatus`; flag `movies`; chei rate-limit `moviesCatalog`, `moviesUnlock`, `moviesProgress`, `moviesStream`, `moviesPublish`.

- [ ] **Step 1: Migrarea**

```sql
-- db/migrations/20260921_0003_movies.sql
-- Swypik Movies: micro-seriale verticale. Fiecare episod referă un rând `videos`
-- (transcodare, moderare, captions, like/comment rămân neschimbate).

CREATE TABLE IF NOT EXISTS movie_publishers (
    user_id     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
    approved_at timestamptz NOT NULL DEFAULT now(),
    note        text
);

CREATE TABLE IF NOT EXISTS movie_series (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug                text NOT NULL UNIQUE,
    owner_user_id       uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    title               text NOT NULL,
    synopsis            text NOT NULL DEFAULT '',
    genres              text[] NOT NULL DEFAULT '{}',
    language_code       text NOT NULL DEFAULT 'ro',
    cover_url           text,
    poster_url          text,
    trailer_video_id    uuid REFERENCES videos(id) ON DELETE SET NULL,
    status              text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'pending_review', 'published', 'archived')),
    free_episodes       integer NOT NULL DEFAULT 3 CHECK (free_episodes BETWEEN 0 AND 10),
    episode_price_units bigint NOT NULL CHECK (episode_price_units > 0),
    is_adult            boolean NOT NULL DEFAULT false,
    license_note        text,
    published_at        timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_movie_series_status_published ON movie_series (status, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_movie_series_owner ON movie_series (owner_user_id);

CREATE TABLE IF NOT EXISTS movie_episodes (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    series_id      uuid NOT NULL REFERENCES movie_series(id) ON DELETE CASCADE,
    episode_number integer NOT NULL CHECK (episode_number > 0),
    video_id       uuid NOT NULL UNIQUE REFERENCES videos(id) ON DELETE RESTRICT,
    title          text NOT NULL,
    duration_ms    integer CHECK (duration_ms IS NULL OR duration_ms > 0),
    status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (series_id, episode_number)
);

CREATE TABLE IF NOT EXISTS movie_unlocks (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    series_id           uuid NOT NULL REFERENCES movie_series(id) ON DELETE CASCADE,
    episode_id          uuid REFERENCES movie_episodes(id) ON DELETE CASCADE,
    units_paid          bigint NOT NULL CHECK (units_paid >= 0),
    creator_share_units bigint NOT NULL DEFAULT 0 CHECK (creator_share_units >= 0),
    ledger_ref          text,
    created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_movie_unlocks_episode ON movie_unlocks (user_id, episode_id) WHERE episode_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_movie_unlocks_season  ON movie_unlocks (user_id, series_id) WHERE episode_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_movie_unlocks_user_series ON movie_unlocks (user_id, series_id);

CREATE TABLE IF NOT EXISTS movie_watch_progress (
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    episode_id  uuid NOT NULL REFERENCES movie_episodes(id) ON DELETE CASCADE,
    position_ms integer NOT NULL DEFAULT 0 CHECK (position_ms >= 0),
    completed   boolean NOT NULL DEFAULT false,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, episode_id)
);
CREATE INDEX IF NOT EXISTS idx_movie_progress_user_updated ON movie_watch_progress (user_id, updated_at DESC);
```

- [ ] **Step 2: Config + tipuri**

```ts
// lib/movies/config.ts
/**
 * Parametrii Swypik Movies. Toate valorile vin din env cu fallback explicit —
 * niciun număr magic în rute sau componente.
 */
function intEnv(name: string, fallback: number, min: number, max: number): number {
    const raw = Number(process.env[name]);
    if (!Number.isFinite(raw)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(raw)));
}

/** Cota creatorului din fiecare deblocare, în basis points (7000 = 70 %). */
export const MOVIES_CREATOR_SHARE_BPS = intEnv("MOVIES_CREATOR_SHARE_BPS", 7000, 0, 10_000);
/** Reducere la deblocarea sezonului întreg (procent din suma episoadelor blocate). */
export const MOVIES_SEASON_DISCOUNT_PCT = intEnv("MOVIES_SEASON_DISCOUNT_PCT", 40, 0, 90);
/** Limite pentru prețul per episod (subunități; 100 = 1 SWYP). Publisher-ul alege între ele. */
export const MOVIES_EPISODE_PRICE_MIN_UNITS = intEnv("MOVIES_EPISODE_PRICE_MIN_UNITS", 100, 1, 1_000_000);
export const MOVIES_EPISODE_PRICE_MAX_UNITS = intEnv("MOVIES_EPISODE_PRICE_MAX_UNITS", 5_000, 1, 1_000_000);
export const MOVIES_DEFAULT_EPISODE_PRICE_UNITS = intEnv("MOVIES_DEFAULT_EPISODE_PRICE_UNITS", 500, 1, 1_000_000);
export const MOVIES_DEFAULT_FREE_EPISODES = intEnv("MOVIES_DEFAULT_FREE_EPISODES", 3, 0, 10);
export const MOVIES_MAX_FREE_EPISODES = 10;
export const MOVIES_MAX_EPISODE_DURATION_MS = intEnv("MOVIES_MAX_EPISODE_DURATION_MS", 180_000, 10_000, 3_600_000);
/** Cât e valid un token de stream pentru un episod blocat. */
export const MOVIES_STREAM_TOKEN_TTL_S = intEnv("MOVIES_STREAM_TOKEN_TTL_S", 600, 60, 3_600);
export const MOVIES_CATALOG_PAGE_SIZE = 24;
export const SWYP_UNITS_PER_COIN = 100;
```

```ts
// lib/movies/types.ts
export type SeriesStatus = "draft" | "pending_review" | "published" | "archived";
export type EpisodeStatus = "draft" | "published";

export type MovieSeriesRow = {
    id: string;
    slug: string;
    owner_user_id: string;
    title: string;
    synopsis: string;
    genres: string[];
    language_code: string;
    cover_url: string | null;
    poster_url: string | null;
    trailer_video_id: string | null;
    status: SeriesStatus;
    free_episodes: number;
    /** bigint în DB; pg îl întoarce ca string — normalizat la number în repository. */
    episode_price_units: number;
    is_adult: boolean;
    license_note: string | null;
    published_at: string | null;
    created_at: string;
    updated_at: string;
};

export type MovieEpisodeRow = {
    id: string;
    series_id: string;
    episode_number: number;
    video_id: string;
    title: string;
    duration_ms: number | null;
    status: EpisodeStatus;
    created_at: string;
    updated_at: string;
};

export type MovieUnlockRow = {
    id: string;
    user_id: string;
    series_id: string;
    episode_id: string | null;
    units_paid: number;
    creator_share_units: number;
    ledger_ref: string | null;
    created_at: string;
};

export type MovieProgressRow = {
    user_id: string;
    episode_id: string;
    position_ms: number;
    completed: boolean;
    updated_at: string;
};

/** Ce știe serverul despre viewer când calculează accesul. */
export type ViewerContext = {
    userId: string | null;
    isAdmin: boolean;
    unlockedEpisodeIds: ReadonlySet<string>;
    hasSeasonUnlock: boolean;
};

/** DTO public pentru un episod în pagina serialului / player. */
export type EpisodeDto = {
    id: string;
    number: number;
    title: string;
    durationMs: number | null;
    locked: boolean;
    priceUnits: number;
    progress: { positionMs: number; completed: boolean } | null;
};

export type SeriesDto = {
    id: string;
    slug: string;
    title: string;
    synopsis: string;
    genres: string[];
    coverUrl: string | null;
    posterUrl: string | null;
    trailerVideoId: string | null;
    freeEpisodes: number;
    episodePriceUnits: number;
    seasonPriceUnits: number;
    isAdult: boolean;
    episodeCount: number;
    owner: { id: string; name: string; isOfficial: boolean };
};
```

- [ ] **Step 3: Flag-uri, rate-limit, env**

În `lib/feature-flags.ts`, după `squadBuy`:
```ts
  // Swypik Movies — OFF până există primul serial publicat.
  movies: flag('FEATURE_MOVIES', false),
```
În `lib/feature-flags-client.ts`, după `squadBuy`:
```ts
  movies: flag('NEXT_PUBLIC_FEATURE_MOVIES', false),
```
În `lib/security/rate-limit.ts`, după `mysteryDrop`:
```ts
  moviesCatalog: { limit: 60, window: 60 } as RateLimitConfig,
  moviesUnlock: { limit: 10, window: 60 } as RateLimitConfig,
  moviesProgress: { limit: 60, window: 60 } as RateLimitConfig,
  moviesStream: { limit: 600, window: 60 } as RateLimitConfig,  // segmente HLS: ~1 req/2s + marjă
  moviesPublish: { limit: 5, window: 3600 } as RateLimitConfig,
```
În `.env.example`, la final:
```
# ── Swypik Movies ───────────────────────────────────────────────────────────
FEATURE_MOVIES=false
NEXT_PUBLIC_FEATURE_MOVIES=false
MOVIES_CREATOR_SHARE_BPS=7000
MOVIES_SEASON_DISCOUNT_PCT=40
MOVIES_EPISODE_PRICE_MIN_UNITS=100
MOVIES_EPISODE_PRICE_MAX_UNITS=5000
MOVIES_DEFAULT_EPISODE_PRICE_UNITS=500
MOVIES_DEFAULT_FREE_EPISODES=3
MOVIES_MAX_EPISODE_DURATION_MS=180000
MOVIES_STREAM_TOKEN_TTL_S=600
```

- [ ] **Step 4: Verifică și comite**

Run: `npx tsc --noEmit --incremental false` → 0 erori.
```bash
git add db/migrations/20260921_0003_movies.sql lib/movies/config.ts lib/movies/types.ts lib/feature-flags.ts lib/feature-flags-client.ts lib/security/rate-limit.ts .env.example
git commit -m "feat(movies): schema, config, flag și chei de rate-limit pentru Swypik Movies"
```

---

### Task 2: Reguli de acces și preț (pure, TDD)

**Files:**
- Create: `lib/movies/access.ts`
- Create: `lib/movies/pricing.ts`
- Test: `tests/unit/movies-access.test.ts`, `tests/unit/movies-pricing.test.ts`

**Interfaces:**
- Consumes: `ViewerContext`, `MovieSeriesRow`, `MovieEpisodeRow` (Task 1), `SWYPIK_OFFICIAL_ID` din `lib/config/accounts.ts`.
- Produces:
  - `isFreeEpisode(series: Pick<MovieSeriesRow, "free_episodes">, episode: Pick<MovieEpisodeRow, "episode_number">): boolean`
  - `canPlay(viewer: ViewerContext, series: Pick<MovieSeriesRow, "free_episodes" | "owner_user_id">, episode: Pick<MovieEpisodeRow, "id" | "episode_number">): boolean`
  - `lockedEpisodeCount(series, totalEpisodes: number): number`
  - `seasonPriceUnits(series: Pick<MovieSeriesRow, "free_episodes" | "episode_price_units">, totalEpisodes: number, discountPct?: number): number`
  - `creatorShareUnits(amountUnits: number, ownerUserId: string, viewerUserId: string, shareBps?: number): number`
  - `clampEpisodePrice(units: number): number`

- [ ] **Step 1: Testele (eșuează)**

```ts
// tests/unit/movies-access.test.ts
import { describe, it, expect } from "vitest";
import { isFreeEpisode, canPlay, lockedEpisodeCount } from "@/lib/movies/access";
import type { ViewerContext } from "@/lib/movies/types";

const series = { free_episodes: 3, owner_user_id: "owner-1" };
const ep = (n: number, id = `ep-${n}`) => ({ id, episode_number: n });
const viewer = (over: Partial<ViewerContext> = {}): ViewerContext => ({
  userId: "user-1", isAdmin: false, unlockedEpisodeIds: new Set(), hasSeasonUnlock: false, ...over,
});

describe("movies/access", () => {
  it("episoadele ≤ free_episodes sunt gratuite, restul nu", () => {
    expect(isFreeEpisode(series, ep(1))).toBe(true);
    expect(isFreeEpisode(series, ep(3))).toBe(true);
    expect(isFreeEpisode(series, ep(4))).toBe(false);
    expect(isFreeEpisode({ free_episodes: 0 }, ep(1))).toBe(false);
  });
  it("vizitatorul anonim vede doar episoadele gratuite", () => {
    expect(canPlay(viewer({ userId: null }), series, ep(2))).toBe(true);
    expect(canPlay(viewer({ userId: null }), series, ep(4))).toBe(false);
  });
  it("deblocarea per episod dă acces doar la acel episod", () => {
    const v = viewer({ unlockedEpisodeIds: new Set(["ep-5"]) });
    expect(canPlay(v, series, ep(5))).toBe(true);
    expect(canPlay(v, series, ep(6))).toBe(false);
  });
  it("sezonul deblocat dă acces la tot", () => {
    expect(canPlay(viewer({ hasSeasonUnlock: true }), series, ep(40))).toBe(true);
  });
  it("owner-ul și adminul văd tot", () => {
    expect(canPlay(viewer({ userId: "owner-1" }), series, ep(40))).toBe(true);
    expect(canPlay(viewer({ isAdmin: true }), series, ep(40))).toBe(true);
  });
  it("numără corect episoadele blocate", () => {
    expect(lockedEpisodeCount(series, 40)).toBe(37);
    expect(lockedEpisodeCount(series, 2)).toBe(0);
  });
});
```

```ts
// tests/unit/movies-pricing.test.ts
import { describe, it, expect } from "vitest";
import { seasonPriceUnits, creatorShareUnits, clampEpisodePrice } from "@/lib/movies/pricing";
import { SWYPIK_OFFICIAL_ID } from "@/lib/config/accounts";
import { MOVIES_EPISODE_PRICE_MAX_UNITS, MOVIES_EPISODE_PRICE_MIN_UNITS } from "@/lib/movies/config";

describe("movies/pricing", () => {
  it("prețul sezonului = episoade blocate × preț × (1 − discount)", () => {
    // 40 episoade, 3 gratuite → 37 × 500 = 18500 → −40 % = 11100
    expect(seasonPriceUnits({ free_episodes: 3, episode_price_units: 500 }, 40, 40)).toBe(11100);
    expect(seasonPriceUnits({ free_episodes: 3, episode_price_units: 500 }, 3, 40)).toBe(0);
  });
  it("cota creatorului = 70 % rotunjit în jos; 0 pentru contul oficial și pentru self-unlock", () => {
    expect(creatorShareUnits(500, "owner-1", "viewer-1", 7000)).toBe(350);
    expect(creatorShareUnits(333, "owner-1", "viewer-1", 7000)).toBe(233);
    expect(creatorShareUnits(500, SWYPIK_OFFICIAL_ID, "viewer-1", 7000)).toBe(0);
    expect(creatorShareUnits(500, "owner-1", "owner-1", 7000)).toBe(0);
    expect(creatorShareUnits(0, "owner-1", "viewer-1", 7000)).toBe(0);
  });
  it("prețul per episod se limitează la intervalul configurat", () => {
    expect(clampEpisodePrice(1)).toBe(MOVIES_EPISODE_PRICE_MIN_UNITS);
    expect(clampEpisodePrice(10_000_000)).toBe(MOVIES_EPISODE_PRICE_MAX_UNITS);
    expect(clampEpisodePrice(750.7)).toBe(750);
  });
});
```

- [ ] **Step 2: Rulează** `npx vitest run tests/unit/movies-access.test.ts tests/unit/movies-pricing.test.ts` → FAIL (module lipsă).

- [ ] **Step 3: Implementarea**

```ts
// lib/movies/access.ts
import type { MovieEpisodeRow, MovieSeriesRow, ViewerContext } from "./types";

export function isFreeEpisode(
    series: Pick<MovieSeriesRow, "free_episodes">,
    episode: Pick<MovieEpisodeRow, "episode_number">,
): boolean {
    return episode.episode_number <= series.free_episodes;
}

export function lockedEpisodeCount(series: Pick<MovieSeriesRow, "free_episodes">, totalEpisodes: number): number {
    return Math.max(0, totalEpisodes - series.free_episodes);
}

/** Singura regulă de acces la un episod; folosită de play, stream și feed. */
export function canPlay(
    viewer: ViewerContext,
    series: Pick<MovieSeriesRow, "free_episodes" | "owner_user_id">,
    episode: Pick<MovieEpisodeRow, "id" | "episode_number">,
): boolean {
    if (isFreeEpisode(series, episode)) return true;
    if (viewer.isAdmin) return true;
    if (viewer.userId && viewer.userId === series.owner_user_id) return true;
    if (viewer.hasSeasonUnlock) return true;
    return viewer.unlockedEpisodeIds.has(episode.id);
}
```

```ts
// lib/movies/pricing.ts
import { SWYPIK_OFFICIAL_ID } from "@/lib/config/accounts";
import {
    MOVIES_CREATOR_SHARE_BPS,
    MOVIES_EPISODE_PRICE_MAX_UNITS,
    MOVIES_EPISODE_PRICE_MIN_UNITS,
    MOVIES_SEASON_DISCOUNT_PCT,
} from "./config";
import { lockedEpisodeCount } from "./access";
import type { MovieSeriesRow } from "./types";

export function seasonPriceUnits(
    series: Pick<MovieSeriesRow, "free_episodes" | "episode_price_units">,
    totalEpisodes: number,
    discountPct: number = MOVIES_SEASON_DISCOUNT_PCT,
): number {
    const locked = lockedEpisodeCount(series, totalEpisodes);
    if (locked === 0) return 0;
    return Math.round(locked * series.episode_price_units * (1 - discountPct / 100));
}

/**
 * Cota creatorului dintr-o deblocare. Zero când serialul e al contului oficial
 * (platforma nu se plătește pe sine) și când viewer-ul e chiar owner-ul
 * (altfel ar putea „recicla" SWYP prin pool).
 */
export function creatorShareUnits(
    amountUnits: number,
    ownerUserId: string,
    viewerUserId: string,
    shareBps: number = MOVIES_CREATOR_SHARE_BPS,
): number {
    if (amountUnits <= 0) return 0;
    if (ownerUserId === SWYPIK_OFFICIAL_ID || ownerUserId === viewerUserId) return 0;
    return Math.floor((amountUnits * shareBps) / 10_000);
}

export function clampEpisodePrice(units: number): number {
    const n = Math.trunc(Number(units) || 0);
    return Math.min(MOVIES_EPISODE_PRICE_MAX_UNITS, Math.max(MOVIES_EPISODE_PRICE_MIN_UNITS, n));
}
```

- [ ] **Step 4: Rulează** aceleași teste → PASS.

- [ ] **Step 5: Commit**
```bash
git add lib/movies/access.ts lib/movies/pricing.ts tests/unit/movies-access.test.ts tests/unit/movies-pricing.test.ts
git commit -m "feat(movies): reguli pure de acces și preț, cu teste"
```

---

### Task 3: Token de stream și rescriere HLS (pure, TDD)

**Files:**
- Create: `lib/movies/stream-token.ts`, `lib/movies/hls-rewrite.ts`
- Test: `tests/unit/movies-stream.test.ts`

**Interfaces:**
- Produces:
  - `signStreamToken(payload: { userId: string; episodeId: string; expiresAt: number }, secret: string): string`
  - `verifyStreamToken(token: string, secret: string, now?: number): { userId: string; episodeId: string; expiresAt: number } | null`
  - `rewriteHlsPlaylist(playlist: string, playlistUrl: string, toProxy: (absoluteUrl: string) => string): string`
  - `isAllowedMediaUrl(url: string, allowedOrigins: string[]): boolean`

- [ ] **Step 1: Testele**

```ts
// tests/unit/movies-stream.test.ts
import { describe, it, expect } from "vitest";
import { signStreamToken, verifyStreamToken } from "@/lib/movies/stream-token";
import { rewriteHlsPlaylist, isAllowedMediaUrl } from "@/lib/movies/hls-rewrite";

const SECRET = "test-secret-please-ignore";

describe("movies/stream-token", () => {
  const payload = { userId: "u1", episodeId: "e1", expiresAt: 1_800_000_000_000 };
  it("semnătura se verifică și întoarce payload-ul", () => {
    const token = signStreamToken(payload, SECRET);
    expect(verifyStreamToken(token, SECRET, payload.expiresAt - 1000)).toEqual(payload);
  });
  it("respinge token expirat, secret greșit, payload modificat, format invalid", () => {
    const token = signStreamToken(payload, SECRET);
    expect(verifyStreamToken(token, SECRET, payload.expiresAt + 1)).toBeNull();
    expect(verifyStreamToken(token, "other", payload.expiresAt - 1000)).toBeNull();
    const [body, sig] = token.split(".");
    const tampered = Buffer.from(JSON.stringify({ ...payload, episodeId: "e2" })).toString("base64url");
    expect(verifyStreamToken(`${tampered}.${sig}`, SECRET, 0)).toBeNull();
    expect(verifyStreamToken(`${body}`, SECRET, 0)).toBeNull();
    expect(verifyStreamToken("garbage", SECRET, 0)).toBeNull();
  });
});

describe("movies/hls-rewrite", () => {
  const base = "https://media.example.com/videos/hls/abc/index.m3u8";
  const toProxy = (u: string) => `/api/movies/stream/T?p=${encodeURIComponent(u)}`;
  it("rescrie liniile de URI (relative și absolute), lasă tag-urile și comentariile", () => {
    const input = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXTINF:4.0,", "seg0.ts", "#EXTINF:4.0,", "https://media.example.com/videos/hls/abc/seg1.ts", "", "#EXT-X-ENDLIST"].join("\n");
    const out = rewriteHlsPlaylist(input, base, toProxy);
    const lines = out.split("\n");
    expect(lines[3]).toBe(toProxy("https://media.example.com/videos/hls/abc/seg0.ts"));
    expect(lines[5]).toBe(toProxy("https://media.example.com/videos/hls/abc/seg1.ts"));
    expect(lines[0]).toBe("#EXTM3U");
    expect(lines[7]).toBe("#EXT-X-ENDLIST");
  });
  it("rescrie și URI-urile din atributele tag-urilor (chei AES, media alternative)", () => {
    const input = '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-MEDIA:TYPE=AUDIO,URI="audio/a.m3u8"';
    const out = rewriteHlsPlaylist(input, base, toProxy);
    expect(out).toContain(`URI="${toProxy("https://media.example.com/videos/hls/abc/key.bin")}"`);
    expect(out).toContain(`URI="${toProxy("https://media.example.com/videos/hls/abc/audio/a.m3u8")}"`);
  });
  it("permite doar originile media configurate", () => {
    const allowed = ["https://media.example.com"];
    expect(isAllowedMediaUrl("https://media.example.com/videos/x.ts", allowed)).toBe(true);
    expect(isAllowedMediaUrl("https://evil.com/videos/x.ts", allowed)).toBe(false);
    expect(isAllowedMediaUrl("http://media.example.com/x.ts", allowed)).toBe(false);
    expect(isAllowedMediaUrl("not a url", allowed)).toBe(false);
  });
});
```

- [ ] **Step 2: Rulează** `npx vitest run tests/unit/movies-stream.test.ts` → FAIL.

- [ ] **Step 3: Implementarea**

```ts
// lib/movies/stream-token.ts
import { createHmac, timingSafeEqual } from "node:crypto";

export type StreamTokenPayload = { userId: string; episodeId: string; expiresAt: number };

function sign(body: string, secret: string): string {
    return createHmac("sha256", secret).update(body).digest("base64url");
}

/** `base64url(json).hmac` — legat de user + episod, cu expirare absolută (ms). */
export function signStreamToken(payload: StreamTokenPayload, secret: string): string {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${body}.${sign(body, secret)}`;
}

export function verifyStreamToken(token: string, secret: string, now: number = Date.now()): StreamTokenPayload | null {
    const dot = token.indexOf(".");
    if (dot <= 0 || dot === token.length - 1) return null;
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = sign(body, secret);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
        return null;
    }
    const p = parsed as Partial<StreamTokenPayload>;
    if (typeof p.userId !== "string" || typeof p.episodeId !== "string" || typeof p.expiresAt !== "number") return null;
    if (p.expiresAt <= now) return null;
    return { userId: p.userId, episodeId: p.episodeId, expiresAt: p.expiresAt };
}
```

```ts
// lib/movies/hls-rewrite.ts
/**
 * Rescrie un playlist HLS astfel încât fiecare URI (segment, sub-playlist,
 * cheie, media alternativă) să treacă prin proxy-ul nostru cu token.
 * Funcție pură: nu face rețea, nu știe de Next.
 */
const URI_ATTR = /URI="([^"]+)"/g;

export function rewriteHlsPlaylist(
    playlist: string,
    playlistUrl: string,
    toProxy: (absoluteUrl: string) => string,
): string {
    const resolve = (ref: string) => new URL(ref, playlistUrl).toString();
    return playlist
        .split("\n")
        .map((line) => {
            const trimmed = line.trim();
            if (trimmed === "") return line;
            if (trimmed.startsWith("#")) {
                return line.replace(URI_ATTR, (_m, uri: string) => `URI="${toProxy(resolve(uri))}"`);
            }
            return toProxy(resolve(trimmed));
        })
        .join("\n");
}

/** Proxy-ul acceptă doar URL-uri de pe originile media ale platformei (anti-SSRF). */
export function isAllowedMediaUrl(url: string, allowedOrigins: string[]): boolean {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    return allowedOrigins.some((origin) => {
        try {
            return new URL(origin).origin === parsed.origin;
        } catch {
            return false;
        }
    });
}
```

- [ ] **Step 4: Rulează** testele → PASS.

- [ ] **Step 5: Commit**
```bash
git add lib/movies/stream-token.ts lib/movies/hls-rewrite.ts tests/unit/movies-stream.test.ts
git commit -m "feat(movies): token HMAC de stream și rescriere HLS pentru proxy, cu teste"
```

---

### Task 4: Repository SQL și sincronizarea vizibilității

**Files:**
- Create: `lib/movies/repository.ts`, `lib/movies/visibility.ts`
- Test: `tests/unit/movies-visibility.test.ts`

**Interfaces:**
- Consumes: `dbQuery`, `withTransaction`, `TxQuery` din `lib/db.ts`; tipurile din Task 1; `isFreeEpisode` din Task 2.
- Produces (toate `async`, în `repository.ts`):
  - `getSeriesBySlug(slug: string): Promise<MovieSeriesRow | null>`
  - `getSeriesById(id: string): Promise<MovieSeriesRow | null>`
  - `listPublishedSeries(opts: { genre?: string; sort: "trending" | "new"; limit: number; offset: number; includeAdult: boolean }): Promise<Array<MovieSeriesRow & { episode_count: number; owner_name: string | null }>>`
  - `listEpisodes(seriesId: string, opts?: { publishedOnly?: boolean }): Promise<MovieEpisodeRow[]>`
  - `getEpisode(seriesId: string, episodeNumber: number): Promise<MovieEpisodeRow | null>`
  - `getEpisodeById(id: string): Promise<(MovieEpisodeRow & { playback_url: string | null; thumbnail_url: string | null }) | null>`
  - `getViewerUnlocks(userId: string, seriesId: string): Promise<{ episodeIds: Set<string>; season: boolean }>`
  - `getProgress(userId: string, seriesId: string): Promise<MovieProgressRow[]>`
  - `upsertProgress(userId: string, episodeId: string, positionMs: number, completed: boolean): Promise<void>`
  - `listContinueWatching(userId: string, limit: number): Promise<Array<{ series: MovieSeriesRow; episode: MovieEpisodeRow; position_ms: number }>>`
  - `isPublisher(userId: string): Promise<boolean>`
  - `createSeries(input: CreateSeriesInput): Promise<MovieSeriesRow>` unde `CreateSeriesInput = { ownerUserId: string; slug: string; title: string; synopsis: string; genres: string[]; languageCode: string; coverUrl: string | null; posterUrl: string | null; freeEpisodes: number; episodePriceUnits: number; isAdult: boolean; licenseNote: string | null }`
  - `updateSeries(id: string, ownerUserId: string | null, patch: Partial<Omit<CreateSeriesInput, "ownerUserId" | "slug">> & { status?: SeriesStatus; trailerVideoId?: string | null }): Promise<MovieSeriesRow | null>` (ownerUserId `null` = admin, fără filtrare pe owner)
  - `addEpisode(input: { seriesId: string; episodeNumber: number; videoId: string; title: string; durationMs: number | null }): Promise<MovieEpisodeRow>`
  - `listSeriesForOwner(ownerUserId: string): Promise<Array<MovieSeriesRow & { episode_count: number }>>`
  - `listSeriesForAdmin(status?: SeriesStatus): Promise<Array<MovieSeriesRow & { episode_count: number; owner_name: string | null }>>`
  - `ownsReadyVideo(userId: string, videoId: string): Promise<{ duration_ms: number | null; moderation_status: string } | null>`
  - `creatorShareTotals(ownerUserId: string): Promise<{ total_units: number; unlocks: number }>`
- Produces (`visibility.ts`): `syncEpisodeVisibility(q: TxQuery, seriesId: string): Promise<{ made_public: number; made_private: number }>` și helperul pur `targetVisibility(series: Pick<MovieSeriesRow,"free_episodes"|"status">, episode: Pick<MovieEpisodeRow,"episode_number"|"status">): "public" | "private"`.

- [ ] **Step 1: Test pentru regula pură de vizibilitate**

```ts
// tests/unit/movies-visibility.test.ts
import { describe, it, expect } from "vitest";
import { targetVisibility } from "@/lib/movies/visibility";

describe("movies/visibility", () => {
  const published = { free_episodes: 3, status: "published" as const };
  it("episoadele gratuite ale unui serial publicat sunt public; restul private", () => {
    expect(targetVisibility(published, { episode_number: 1, status: "published" })).toBe("public");
    expect(targetVisibility(published, { episode_number: 3, status: "published" })).toBe("public");
    expect(targetVisibility(published, { episode_number: 4, status: "published" })).toBe("private");
  });
  it("orice episod nepublicat sau dintr-un serial nepublicat este private", () => {
    expect(targetVisibility(published, { episode_number: 1, status: "draft" })).toBe("private");
    expect(targetVisibility({ free_episodes: 3, status: "draft" }, { episode_number: 1, status: "published" })).toBe("private");
  });
});
```

- [ ] **Step 2: Rulează** → FAIL.

- [ ] **Step 3: Implementarea**

```ts
// lib/movies/visibility.ts
import type { TxQuery } from "@/lib/db";
import { isFreeEpisode } from "./access";
import type { MovieEpisodeRow, MovieSeriesRow } from "./types";

/**
 * Un episod blocat NU are voie să fie `public` în `videos`: feed-ul, căutarea și
 * pagina /v/[id] filtrează pe visibility='public', deci `private` este ceea ce
 * ține episoadele plătite în afara oricărei suprafețe, în afară de player-ul
 * Movies (care citește playback_url server-side, după verificarea accesului).
 */
export function targetVisibility(
    series: Pick<MovieSeriesRow, "free_episodes" | "status">,
    episode: Pick<MovieEpisodeRow, "episode_number" | "status">,
): "public" | "private" {
    if (series.status !== "published" || episode.status !== "published") return "private";
    return isFreeEpisode(series, episode) ? "public" : "private";
}

/** Aliniază `videos.visibility` pentru toate episoadele unui serial (în tranzacția apelantului). */
export async function syncEpisodeVisibility(q: TxQuery, seriesId: string): Promise<{ made_public: number; made_private: number }> {
    const { rows } = await q<{ free_episodes: number; status: MovieSeriesRow["status"] }>(
        `SELECT free_episodes, status FROM movie_series WHERE id = $1 FOR UPDATE`,
        [seriesId],
    );
    const series = rows[0];
    if (!series) return { made_public: 0, made_private: 0 };

    const { rows: episodes } = await q<Pick<MovieEpisodeRow, "video_id" | "episode_number" | "status">>(
        `SELECT video_id, episode_number, status FROM movie_episodes WHERE series_id = $1`,
        [seriesId],
    );
    const publicIds = episodes.filter((e) => targetVisibility(series, e) === "public").map((e) => e.video_id);
    const privateIds = episodes.filter((e) => targetVisibility(series, e) === "private").map((e) => e.video_id);

    const pub = publicIds.length
        ? await q(`UPDATE videos SET visibility = 'public', updated_at = now() WHERE id = ANY($1::uuid[]) AND visibility <> 'public'`, [publicIds])
        : { rowCount: 0 };
    const priv = privateIds.length
        ? await q(`UPDATE videos SET visibility = 'private', updated_at = now() WHERE id = ANY($1::uuid[]) AND visibility <> 'private'`, [privateIds])
        : { rowCount: 0 };
    return { made_public: pub.rowCount, made_private: priv.rowCount };
}
```

```ts
// lib/movies/repository.ts
import { dbQuery, withTransaction } from "@/lib/db";
import type { MovieEpisodeRow, MovieProgressRow, MovieSeriesRow, SeriesStatus } from "./types";
import { syncEpisodeVisibility } from "./visibility";

const SERIES_COLS = `id, slug, owner_user_id, title, synopsis, genres, language_code, cover_url, poster_url,
    trailer_video_id, status, free_episodes, episode_price_units::text AS episode_price_units, is_adult,
    license_note, published_at, created_at, updated_at`;

function normalizeSeries<T extends { episode_price_units: string | number }>(row: T): T & { episode_price_units: number } {
    return { ...row, episode_price_units: Number(row.episode_price_units) };
}

export async function getSeriesBySlug(slug: string): Promise<MovieSeriesRow | null> {
    const { rows } = await dbQuery<MovieSeriesRow>(`SELECT ${SERIES_COLS} FROM movie_series WHERE slug = $1`, [slug]);
    return rows[0] ? normalizeSeries(rows[0]) : null;
}

export async function getSeriesById(id: string): Promise<MovieSeriesRow | null> {
    const { rows } = await dbQuery<MovieSeriesRow>(`SELECT ${SERIES_COLS} FROM movie_series WHERE id = $1`, [id]);
    return rows[0] ? normalizeSeries(rows[0]) : null;
}

export type ListSeriesOpts = { genre?: string; sort: "trending" | "new"; limit: number; offset: number; includeAdult: boolean };

/** Trending = deblocări + progres în ultimele 7 zile; New = published_at. */
export async function listPublishedSeries(opts: ListSeriesOpts) {
    const params: unknown[] = [opts.limit, opts.offset];
    const where: string[] = [`s.status = 'published'`];
    if (!opts.includeAdult) where.push(`s.is_adult = false`);
    if (opts.genre) { params.push(opts.genre); where.push(`$${params.length} = ANY(s.genres)`); }
    const order = opts.sort === "new"
        ? `s.published_at DESC NULLS LAST`
        : `(SELECT COUNT(*) FROM movie_unlocks u WHERE u.series_id = s.id AND u.created_at > now() - interval '7 days')
           + (SELECT COUNT(*) FROM movie_watch_progress p JOIN movie_episodes e ON e.id = p.episode_id
              WHERE e.series_id = s.id AND p.updated_at > now() - interval '7 days') DESC, s.published_at DESC`;
    const { rows } = await dbQuery<MovieSeriesRow & { episode_count: number; owner_name: string | null }>(
        `SELECT ${SERIES_COLS.replace(/(^|, )/g, "$1s.")},
                (SELECT COUNT(*) FROM movie_episodes e WHERE e.series_id = s.id AND e.status = 'published')::int AS episode_count,
                u.display_name AS owner_name
           FROM movie_series s
           LEFT JOIN users u ON u.id = s.owner_user_id
          WHERE ${where.join(" AND ")}
          ORDER BY ${order}
          LIMIT $1 OFFSET $2`,
        params,
    );
    return rows.map(normalizeSeries);
}

export async function listEpisodes(seriesId: string, opts: { publishedOnly?: boolean } = {}): Promise<MovieEpisodeRow[]> {
    const { rows } = await dbQuery<MovieEpisodeRow>(
        `SELECT id, series_id, episode_number, video_id, title, duration_ms, status, created_at, updated_at
           FROM movie_episodes WHERE series_id = $1 ${opts.publishedOnly ? `AND status = 'published'` : ``}
          ORDER BY episode_number ASC`,
        [seriesId],
    );
    return rows;
}

export async function getEpisode(seriesId: string, episodeNumber: number): Promise<MovieEpisodeRow | null> {
    const { rows } = await dbQuery<MovieEpisodeRow>(
        `SELECT id, series_id, episode_number, video_id, title, duration_ms, status, created_at, updated_at
           FROM movie_episodes WHERE series_id = $1 AND episode_number = $2`,
        [seriesId, episodeNumber],
    );
    return rows[0] ?? null;
}

export async function getEpisodeById(id: string) {
    const { rows } = await dbQuery<MovieEpisodeRow & { playback_url: string | null; thumbnail_url: string | null }>(
        `SELECT e.id, e.series_id, e.episode_number, e.video_id, e.title, e.duration_ms, e.status, e.created_at, e.updated_at,
                v.playback_url, v.thumbnail_url
           FROM movie_episodes e JOIN videos v ON v.id = e.video_id WHERE e.id = $1`,
        [id],
    );
    return rows[0] ?? null;
}

export async function getViewerUnlocks(userId: string, seriesId: string): Promise<{ episodeIds: Set<string>; season: boolean }> {
    const { rows } = await dbQuery<{ episode_id: string | null }>(
        `SELECT episode_id FROM movie_unlocks WHERE user_id = $1 AND series_id = $2`,
        [userId, seriesId],
    );
    return {
        episodeIds: new Set(rows.map((r) => r.episode_id).filter((x): x is string => Boolean(x))),
        season: rows.some((r) => r.episode_id === null),
    };
}

export async function getProgress(userId: string, seriesId: string): Promise<MovieProgressRow[]> {
    const { rows } = await dbQuery<MovieProgressRow>(
        `SELECT p.user_id, p.episode_id, p.position_ms, p.completed, p.updated_at
           FROM movie_watch_progress p JOIN movie_episodes e ON e.id = p.episode_id
          WHERE p.user_id = $1 AND e.series_id = $2`,
        [userId, seriesId],
    );
    return rows;
}

export async function upsertProgress(userId: string, episodeId: string, positionMs: number, completed: boolean): Promise<void> {
    await dbQuery(
        `INSERT INTO movie_watch_progress (user_id, episode_id, position_ms, completed)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, episode_id) DO UPDATE
            SET position_ms = EXCLUDED.position_ms,
                completed = movie_watch_progress.completed OR EXCLUDED.completed,
                updated_at = now()`,
        [userId, episodeId, positionMs, completed],
    );
}

export async function listContinueWatching(userId: string, limit: number) {
    const { rows } = await dbQuery<{ series: MovieSeriesRow; episode: MovieEpisodeRow; position_ms: number }>(
        `SELECT DISTINCT ON (s.id)
                to_jsonb(s) AS series, to_jsonb(e) AS episode, p.position_ms
           FROM movie_watch_progress p
           JOIN movie_episodes e ON e.id = p.episode_id
           JOIN movie_series s ON s.id = e.series_id
          WHERE p.user_id = $1 AND p.completed = false AND s.status = 'published'
          ORDER BY s.id, p.updated_at DESC
          LIMIT $2`,
        [userId, limit],
    );
    return rows.map((r) => ({ ...r, series: normalizeSeries(r.series) }));
}

export async function isPublisher(userId: string): Promise<boolean> {
    const { rows } = await dbQuery(`SELECT 1 FROM movie_publishers WHERE user_id = $1`, [userId]);
    return rows.length > 0;
}

export type CreateSeriesInput = {
    ownerUserId: string; slug: string; title: string; synopsis: string; genres: string[]; languageCode: string;
    coverUrl: string | null; posterUrl: string | null; freeEpisodes: number; episodePriceUnits: number;
    isAdult: boolean; licenseNote: string | null;
};

export async function createSeries(i: CreateSeriesInput): Promise<MovieSeriesRow> {
    const { rows } = await dbQuery<MovieSeriesRow>(
        `INSERT INTO movie_series (owner_user_id, slug, title, synopsis, genres, language_code, cover_url, poster_url,
                                   free_episodes, episode_price_units, is_adult, license_note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING ${SERIES_COLS}`,
        [i.ownerUserId, i.slug, i.title, i.synopsis, i.genres, i.languageCode, i.coverUrl, i.posterUrl,
         i.freeEpisodes, i.episodePriceUnits, i.isAdult, i.licenseNote],
    );
    return normalizeSeries(rows[0]);
}

export type UpdateSeriesPatch = Partial<Omit<CreateSeriesInput, "ownerUserId" | "slug">> & {
    status?: SeriesStatus; trailerVideoId?: string | null;
};

const PATCH_COLUMNS: Record<keyof UpdateSeriesPatch, string> = {
    title: "title", synopsis: "synopsis", genres: "genres", languageCode: "language_code", coverUrl: "cover_url",
    posterUrl: "poster_url", freeEpisodes: "free_episodes", episodePriceUnits: "episode_price_units",
    isAdult: "is_adult", licenseNote: "license_note", status: "status", trailerVideoId: "trailer_video_id",
};

/** `ownerUserId === null` = admin (fără restricție de owner). Re-sincronizează vizibilitatea episoadelor. */
export async function updateSeries(id: string, ownerUserId: string | null, patch: UpdateSeriesPatch): Promise<MovieSeriesRow | null> {
    const sets: string[] = []; const params: unknown[] = [id];
    for (const [key, col] of Object.entries(PATCH_COLUMNS) as Array<[keyof UpdateSeriesPatch, string]>) {
        if (patch[key] === undefined) continue;
        params.push(patch[key]); sets.push(`${col} = $${params.length}`);
    }
    if (patch.status === "published") sets.push(`published_at = COALESCE(published_at, now())`);
    if (sets.length === 0) return getSeriesById(id);
    if (ownerUserId) params.push(ownerUserId);
    return withTransaction(async (q) => {
        const { rows } = await q<MovieSeriesRow>(
            `UPDATE movie_series SET ${sets.join(", ")}, updated_at = now()
              WHERE id = $1 ${ownerUserId ? `AND owner_user_id = $${params.length}` : ``}
              RETURNING ${SERIES_COLS}`,
            params,
        );
        if (!rows[0]) return null;
        await syncEpisodeVisibility(q, id);
        return normalizeSeries(rows[0]);
    });
}

export async function addEpisode(i: { seriesId: string; episodeNumber: number; videoId: string; title: string; durationMs: number | null }): Promise<MovieEpisodeRow> {
    return withTransaction(async (q) => {
        const { rows } = await q<MovieEpisodeRow>(
            `INSERT INTO movie_episodes (series_id, episode_number, video_id, title, duration_ms, status)
             VALUES ($1, $2, $3, $4, $5, 'published')
             RETURNING id, series_id, episode_number, video_id, title, duration_ms, status, created_at, updated_at`,
            [i.seriesId, i.episodeNumber, i.videoId, i.title, i.durationMs],
        );
        await syncEpisodeVisibility(q, i.seriesId);
        return rows[0];
    });
}

export async function listSeriesForOwner(ownerUserId: string) {
    const { rows } = await dbQuery<MovieSeriesRow & { episode_count: number }>(
        `SELECT ${SERIES_COLS.replace(/(^|, )/g, "$1s.")},
                (SELECT COUNT(*) FROM movie_episodes e WHERE e.series_id = s.id)::int AS episode_count
           FROM movie_series s WHERE s.owner_user_id = $1 ORDER BY s.updated_at DESC`,
        [ownerUserId],
    );
    return rows.map(normalizeSeries);
}

export async function listSeriesForAdmin(status?: SeriesStatus) {
    const { rows } = await dbQuery<MovieSeriesRow & { episode_count: number; owner_name: string | null }>(
        `SELECT ${SERIES_COLS.replace(/(^|, )/g, "$1s.")},
                (SELECT COUNT(*) FROM movie_episodes e WHERE e.series_id = s.id)::int AS episode_count,
                u.display_name AS owner_name
           FROM movie_series s LEFT JOIN users u ON u.id = s.owner_user_id
          ${status ? `WHERE s.status = $1` : ``}
          ORDER BY s.updated_at DESC LIMIT 200`,
        status ? [status] : [],
    );
    return rows.map(normalizeSeries);
}

export async function ownsReadyVideo(userId: string, videoId: string) {
    const { rows } = await dbQuery<{ duration_ms: number | null; moderation_status: string }>(
        `SELECT duration_ms, moderation_status FROM videos
          WHERE id = $1 AND creator_id = $2 AND status = 'ready' AND is_hidden = false`,
        [videoId, userId],
    );
    return rows[0] ?? null;
}

export async function creatorShareTotals(ownerUserId: string): Promise<{ total_units: number; unlocks: number }> {
    const { rows } = await dbQuery<{ total_units: string; unlocks: string }>(
        `SELECT COALESCE(SUM(u.creator_share_units), 0)::text AS total_units, COUNT(*)::text AS unlocks
           FROM movie_unlocks u JOIN movie_series s ON s.id = u.series_id
          WHERE s.owner_user_id = $1 AND u.creator_share_units > 0`,
        [ownerUserId],
    );
    return { total_units: Number(rows[0]?.total_units ?? 0), unlocks: Number(rows[0]?.unlocks ?? 0) };
}
```

- [ ] **Step 4: Rulează** `npx vitest run tests/unit/movies-visibility.test.ts` → PASS; `npx tsc --noEmit --incremental false` → 0.

- [ ] **Step 5: Commit**
```bash
git add lib/movies/repository.ts lib/movies/visibility.ts tests/unit/movies-visibility.test.ts
git commit -m "feat(movies): repository SQL și sincronizarea vizibilității episoadelor"
```

---

### Task 5: Deblocarea (tranzacție SWYP + cotă creator), TDD cu DB mock

**Files:**
- Create: `lib/movies/unlock.ts`
- Test: `tests/unit/movies-unlock.test.ts`

**Interfaces:**
- Consumes: `withTransaction` (`lib/db.ts`), `swypTransferInTx`, `SwypInsufficientFundsError` (`lib/swyp/ledger.ts`), `creatorShareUnits`, `seasonPriceUnits`, `isFreeEpisode`.
- Produces:
  - `unlockEpisode(args: { userId: string; episodeId: string }): Promise<UnlockResult>`
  - `unlockSeason(args: { userId: string; seriesId: string }): Promise<UnlockResult>`
  - `type UnlockResult = { ok: true; alreadyApplied: boolean; unitsPaid: number; creatorShareUnits: number } | { ok: false; reason: "not_found" | "already_free" | "series_not_published" | "insufficient_balance" }`
  - `unlockRefId(userId: string, target: { episodeId: string } | { seriesId: string }): string` (determinist: `movie_unlock:<userId>:episode:<id>` / `...:season:<id>`)

- [ ] **Step 1: Testele**

```ts
// tests/unit/movies-unlock.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const transfers: Array<Record<string, unknown>> = [];
const inserted: Array<unknown[]> = [];
let insertConflict = false;
let insufficient = false;

vi.mock("@/lib/db", () => ({
  withTransaction: async (fn: (q: unknown) => Promise<unknown>) => fn(query),
  dbQuery: vi.fn(),
}));
vi.mock("@/lib/swyp/ledger", async () => {
  class SwypInsufficientFundsError extends Error {}
  return {
    SwypInsufficientFundsError,
    swypTransferInTx: vi.fn(async (_q: unknown, args: Record<string, unknown>) => {
      if (insufficient && args.kind === "spend") throw new SwypInsufficientFundsError("insufficient");
      transfers.push(args);
      return { entry: { id: `entry-${transfers.length}` }, alreadyApplied: false };
    }),
  };
});

const series = { id: "s1", owner_user_id: "owner-1", status: "published", free_episodes: 3, episode_price_units: "500" };
async function query(sql: string, params: unknown[] = []) {
  if (sql.includes("FROM movie_episodes e") && sql.includes("JOIN movie_series")) {
    return { rows: [{ id: "ep-5", series_id: "s1", episode_number: 5, ...series }], rowCount: 1 };
  }
  if (sql.includes("FROM movie_series") && sql.includes("FOR UPDATE")) return { rows: [series], rowCount: 1 };
  if (sql.includes("COUNT(*)") && sql.includes("movie_episodes")) return { rows: [{ count: "40" }], rowCount: 1 };
  if (sql.startsWith("INSERT INTO movie_unlocks")) {
    if (insertConflict) return { rows: [], rowCount: 0 };
    inserted.push(params); return { rows: [{ id: "unlock-1" }], rowCount: 1 };
  }
  if (sql.startsWith("UPDATE movie_unlocks")) return { rows: [], rowCount: 1 };
  throw new Error("unexpected sql: " + sql.slice(0, 60));
}

import { unlockEpisode, unlockSeason, unlockRefId } from "@/lib/movies/unlock";

beforeEach(() => { transfers.length = 0; inserted.length = 0; insertConflict = false; insufficient = false; });

describe("movies/unlock", () => {
  it("refId-ul este determinist per user+țintă", () => {
    expect(unlockRefId("u1", { episodeId: "e1" })).toBe("movie_unlock:u1:episode:e1");
    expect(unlockRefId("u1", { seriesId: "s1" })).toBe("movie_unlock:u1:season:s1");
  });
  it("deblocarea unui episod: debit viewer + cotă creator, în această ordine, cu același refId", async () => {
    const r = await unlockEpisode({ userId: "viewer-1", episodeId: "ep-5" });
    expect(r).toEqual({ ok: true, alreadyApplied: false, unitsPaid: 500, creatorShareUnits: 350 });
    expect(transfers).toHaveLength(2);
    expect(transfers[0]).toMatchObject({ kind: "spend", from: { userId: "viewer-1" }, to: { pool: "rewards" }, amountUnits: 500n, refType: "movie_unlock", refId: "movie_unlock:viewer-1:episode:ep-5" });
    expect(transfers[1]).toMatchObject({ kind: "reward", from: { pool: "rewards" }, to: { userId: "owner-1" }, amountUnits: 350n, refType: "movie_creator_share", refId: "movie_unlock:viewer-1:episode:ep-5" });
  });
  it("al doilea apel (dublu-tap) nu mai debitează nimic", async () => {
    insertConflict = true;
    const r = await unlockEpisode({ userId: "viewer-1", episodeId: "ep-5" });
    expect(r).toEqual({ ok: true, alreadyApplied: true, unitsPaid: 0, creatorShareUnits: 0 });
    expect(transfers).toHaveLength(0);
  });
  it("sold insuficient → insufficient_balance, fără rând de unlock", async () => {
    insufficient = true;
    const r = await unlockEpisode({ userId: "viewer-1", episodeId: "ep-5" });
    expect(r).toEqual({ ok: false, reason: "insufficient_balance" });
  });
  it("owner-ul nu primește cotă când își deblochează propriul serial", async () => {
    await unlockEpisode({ userId: "owner-1", episodeId: "ep-5" });
    expect(transfers).toHaveLength(1);
    expect(transfers[0]).toMatchObject({ kind: "spend" });
  });
  it("sezonul: 37 episoade blocate × 500 − 40 % = 11100, cotă 7770", async () => {
    const r = await unlockSeason({ userId: "viewer-1", seriesId: "s1" });
    expect(r).toEqual({ ok: true, alreadyApplied: false, unitsPaid: 11100, creatorShareUnits: 7770 });
  });
});
```

- [ ] **Step 2: Rulează** `npx vitest run tests/unit/movies-unlock.test.ts` → FAIL.

- [ ] **Step 3: Implementarea**

```ts
// lib/movies/unlock.ts
import { withTransaction, type TxQuery } from "@/lib/db";
import { swypTransferInTx, SwypInsufficientFundsError } from "@/lib/swyp/ledger";
import { logger } from "@/lib/logger";
import { isFreeEpisode } from "./access";
import { creatorShareUnits, seasonPriceUnits } from "./pricing";
import type { MovieSeriesRow } from "./types";

export type UnlockResult =
    | { ok: true; alreadyApplied: boolean; unitsPaid: number; creatorShareUnits: number }
    | { ok: false; reason: "not_found" | "already_free" | "series_not_published" | "insufficient_balance" };

export function unlockRefId(userId: string, target: { episodeId: string } | { seriesId: string }): string {
    return "episodeId" in target
        ? `movie_unlock:${userId}:episode:${target.episodeId}`
        : `movie_unlock:${userId}:season:${target.seriesId}`;
}

type SeriesLite = Pick<MovieSeriesRow, "id" | "owner_user_id" | "status" | "free_episodes"> & { episode_price_units: string | number };

/**
 * Mută banii și scrie rândul de unlock în ACEEAȘI tranzacție:
 *   1. INSERT movie_unlocks … ON CONFLICT DO NOTHING — garda de idempotență (dublu-tap, retry);
 *   2. spend viewer → pool rewards (refId determinist ⇒ ledger-ul e și el idempotent);
 *   3. reward pool → creator (cota), sărit când e 0;
 *   4. UPDATE movie_unlocks cu suma/cota/ref.
 * Sold insuficient ⇒ SwypInsufficientFundsError ⇒ ROLLBACK (rândul din 1 dispare).
 */
async function settle(
    q: TxQuery,
    args: { userId: string; series: SeriesLite; episodeId: string | null; amountUnits: number; refId: string },
): Promise<UnlockResult> {
    const { rows } = await q<{ id: string }>(
        `INSERT INTO movie_unlocks (user_id, series_id, episode_id, units_paid, creator_share_units)
         VALUES ($1, $2, $3, 0, 0)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [args.userId, args.series.id, args.episodeId],
    );
    const unlockId = rows[0]?.id;
    if (!unlockId) return { ok: true, alreadyApplied: true, unitsPaid: 0, creatorShareUnits: 0 };

    const spend = await swypTransferInTx(q, {
        from: { userId: args.userId },
        to: { pool: "rewards" },
        amountUnits: BigInt(args.amountUnits),
        kind: "spend",
        refType: "movie_unlock",
        refId: args.refId,
        description: `Swypik Movies unlock`,
        metadata: { series_id: args.series.id, episode_id: args.episodeId },
    });

    const share = creatorShareUnits(args.amountUnits, args.series.owner_user_id, args.userId);
    if (share > 0) {
        await swypTransferInTx(q, {
            from: { pool: "rewards" },
            to: { userId: args.series.owner_user_id },
            amountUnits: BigInt(share),
            kind: "reward",
            refType: "movie_creator_share",
            refId: args.refId,
            description: `Swypik Movies creator share`,
            metadata: { series_id: args.series.id, episode_id: args.episodeId, viewer_id: args.userId },
        });
    }

    await q(
        `UPDATE movie_unlocks SET units_paid = $2, creator_share_units = $3, ledger_ref = $4 WHERE id = $1`,
        [unlockId, args.amountUnits, share, spend.entry.id],
    );
    return { ok: true, alreadyApplied: false, unitsPaid: args.amountUnits, creatorShareUnits: share };
}

async function run(fn: (q: TxQuery) => Promise<UnlockResult>): Promise<UnlockResult> {
    try {
        return await withTransaction(fn);
    } catch (err) {
        if (err instanceof SwypInsufficientFundsError) return { ok: false, reason: "insufficient_balance" };
        logger.error({ err }, "[movies/unlock] failed");
        throw err;
    }
}

export async function unlockEpisode(args: { userId: string; episodeId: string }): Promise<UnlockResult> {
    return run(async (q) => {
        const { rows } = await q<SeriesLite & { episode_number: number; series_id: string }>(
            `SELECT e.episode_number, e.series_id, s.id, s.owner_user_id, s.status, s.free_episodes, s.episode_price_units::text
               FROM movie_episodes e JOIN movie_series s ON s.id = e.series_id
              WHERE e.id = $1 AND e.status = 'published'`,
            [args.episodeId],
        );
        const row = rows[0];
        if (!row) return { ok: false, reason: "not_found" };
        if (row.status !== "published") return { ok: false, reason: "series_not_published" };
        if (isFreeEpisode(row, row)) return { ok: false, reason: "already_free" };
        return settle(q, {
            userId: args.userId, series: row, episodeId: args.episodeId,
            amountUnits: Number(row.episode_price_units), refId: unlockRefId(args.userId, { episodeId: args.episodeId }),
        });
    });
}

export async function unlockSeason(args: { userId: string; seriesId: string }): Promise<UnlockResult> {
    return run(async (q) => {
        const { rows } = await q<SeriesLite>(
            `SELECT id, owner_user_id, status, free_episodes, episode_price_units::text
               FROM movie_series WHERE id = $1 FOR UPDATE`,
            [args.seriesId],
        );
        const series = rows[0];
        if (!series) return { ok: false, reason: "not_found" };
        if (series.status !== "published") return { ok: false, reason: "series_not_published" };
        const { rows: cnt } = await q<{ count: string }>(
            `SELECT COUNT(*)::text AS count FROM movie_episodes WHERE series_id = $1 AND status = 'published'`,
            [args.seriesId],
        );
        const amount = seasonPriceUnits({ free_episodes: series.free_episodes, episode_price_units: Number(series.episode_price_units) }, Number(cnt[0]?.count ?? 0));
        if (amount === 0) return { ok: false, reason: "already_free" };
        return settle(q, { userId: args.userId, series, episodeId: null, amountUnits: amount, refId: unlockRefId(args.userId, { seriesId: args.seriesId }) });
    });
}
```

- [ ] **Step 4: Rulează** testele → PASS. Dacă `SwypInsufficientFundsError` nu e exportată din `lib/swyp/ledger.ts`, adaugă `export` pe clasa existentă (linia ~50) — nu crea o clasă nouă.

- [ ] **Step 5: Commit**
```bash
git add lib/movies/unlock.ts tests/unit/movies-unlock.test.ts
git commit -m "feat(movies): deblocare episod/sezon cu SWYP și cotă instant pentru creator, idempotentă"
```

---

### Task 6: API public (catalog, serial, play, unlock, progress, stream)

**Files:**
- Create: `lib/movies/viewer.ts`, `lib/movies/dto.ts`
- Create: `app/api/movies/route.ts`, `app/api/movies/[slug]/route.ts`, `app/api/movies/[slug]/episodes/[n]/play/route.ts`, `app/api/movies/[slug]/unlock/route.ts`, `app/api/movies/progress/route.ts`, `app/api/movies/stream/[token]/route.ts`

**Interfaces:**
- Consumes: Task 2–5; `getAuthUser` (`lib/auth/getAuthUser.ts`, întoarce `{ role, userId, isAdmin }`), `getSwypBalanceUnits` (`lib/swyp/ledger.ts`), `getVideoAssetUrl` (`lib/storage/video-storage.ts`).
- Produces: `buildViewerContext(userId, isAdmin, seriesId)`, `toSeriesDto(series, episodeCount, ownerName)`, `toEpisodeDtos(series, episodes, viewer, progress)`; endpoint-urile cu formele JSON de mai jos.

- [ ] **Step 1: Helperi**

```ts
// lib/movies/viewer.ts
import { getViewerUnlocks } from "./repository";
import type { ViewerContext } from "./types";

export async function buildViewerContext(userId: string | null, isAdmin: boolean, seriesId: string): Promise<ViewerContext> {
    if (!userId) return { userId: null, isAdmin: false, unlockedEpisodeIds: new Set(), hasSeasonUnlock: false };
    const unlocks = await getViewerUnlocks(userId, seriesId);
    return { userId, isAdmin, unlockedEpisodeIds: unlocks.episodeIds, hasSeasonUnlock: unlocks.season };
}
```

```ts
// lib/movies/dto.ts
import { SWYPIK_OFFICIAL_ID } from "@/lib/config/accounts";
import { canPlay } from "./access";
import { seasonPriceUnits } from "./pricing";
import type { EpisodeDto, MovieEpisodeRow, MovieProgressRow, MovieSeriesRow, SeriesDto, ViewerContext } from "./types";

export function toSeriesDto(series: MovieSeriesRow, episodeCount: number, ownerName: string | null): SeriesDto {
    return {
        id: series.id, slug: series.slug, title: series.title, synopsis: series.synopsis, genres: series.genres,
        coverUrl: series.cover_url, posterUrl: series.poster_url, trailerVideoId: series.trailer_video_id,
        freeEpisodes: series.free_episodes, episodePriceUnits: series.episode_price_units,
        seasonPriceUnits: seasonPriceUnits(series, episodeCount), isAdult: series.is_adult, episodeCount,
        owner: { id: series.owner_user_id, name: ownerName ?? "Swypik", isOfficial: series.owner_user_id === SWYPIK_OFFICIAL_ID },
    };
}

export function toEpisodeDtos(series: MovieSeriesRow, episodes: MovieEpisodeRow[], viewer: ViewerContext, progress: MovieProgressRow[]): EpisodeDto[] {
    const byEpisode = new Map(progress.map((p) => [p.episode_id, p]));
    return episodes.map((e) => ({
        id: e.id, number: e.episode_number, title: e.title, durationMs: e.duration_ms,
        locked: !canPlay(viewer, series, e), priceUnits: series.episode_price_units,
        progress: byEpisode.has(e.id) ? { positionMs: byEpisode.get(e.id)!.position_ms, completed: byEpisode.get(e.id)!.completed } : null,
    }));
}
```

- [ ] **Step 2: Catalog + serial**

```ts
// app/api/movies/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { withErrorHandling } from "@/lib/api-handler";
import { rateLimit, getClientIp } from "@/lib/security/rate-limit";
import { MOVIES_CATALOG_PAGE_SIZE } from "@/lib/movies/config";
import { listPublishedSeries, listContinueWatching } from "@/lib/movies/repository";
import { toSeriesDto } from "@/lib/movies/dto";

export const dynamic = "force-dynamic";

const QuerySchema = z.object({
    genre: z.string().trim().min(1).max(40).optional(),
    sort: z.enum(["trending", "new"]).default("trending"),
    page: z.coerce.number().int().min(0).max(1000).default(0),
});

export const GET = withErrorHandling(async function GET(req: Request) {
    if (!isEnabled("movies")) return frozenResponse("movies");
    const rl = await rateLimit("moviesCatalog", getClientIp(req));
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

    const parsed = QuerySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
    if (!parsed.success) return NextResponse.json({ error: "invalid_query" }, { status: 400 });
    const { genre, sort, page } = parsed.data;

    const user = await getAuthUser();
    const includeAdult = user.isAdmin; // MVP: doar adminul vede is_adult în catalog; gating-ul complet vine cu age verification
    const series = await listPublishedSeries({ genre, sort, limit: MOVIES_CATALOG_PAGE_SIZE, offset: page * MOVIES_CATALOG_PAGE_SIZE, includeAdult });
    const continueWatching = user.userId ? await listContinueWatching(user.userId, 10) : [];

    return NextResponse.json({
        items: series.map((s) => toSeriesDto(s, s.episode_count, s.owner_name)),
        continueWatching: continueWatching.map((c) => ({ series: toSeriesDto(c.series, 0, null), episodeNumber: c.episode.episode_number, positionMs: c.position_ms, durationMs: c.episode.duration_ms })),
        nextPage: series.length === MOVIES_CATALOG_PAGE_SIZE ? page + 1 : null,
    });
});
```
Dacă `getClientIp` nu există în `lib/security/rate-limit.ts` sub acest nume, folosește exportul existent care extrage IP-ul (caută `export function .*Ip` în fișier) și adaptează importul — nu reimplementa.

```ts
// app/api/movies/[slug]/route.ts
import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { withErrorHandling } from "@/lib/api-handler";
import { getSwypBalanceUnits } from "@/lib/swyp/ledger";
import { getSeriesBySlug, listEpisodes, getProgress } from "@/lib/movies/repository";
import { buildViewerContext } from "@/lib/movies/viewer";
import { toSeriesDto, toEpisodeDtos } from "@/lib/movies/dto";
import { dbQuery } from "@/lib/db";

export const dynamic = "force-dynamic";

export const GET = withErrorHandling(async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
    if (!isEnabled("movies")) return frozenResponse("movies");
    const { slug } = await params;
    const series = await getSeriesBySlug(slug);
    const user = await getAuthUser();
    const isOwner = Boolean(user.userId && series && series.owner_user_id === user.userId);
    if (!series || (series.status !== "published" && !user.isAdmin && !isOwner)) {
        return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    const [episodes, viewer, progress, ownerRows] = await Promise.all([
        listEpisodes(series.id, { publishedOnly: !user.isAdmin && !isOwner }),
        buildViewerContext(user.userId, user.isAdmin, series.id),
        user.userId ? getProgress(user.userId, series.id) : Promise.resolve([]),
        dbQuery<{ display_name: string | null }>(`SELECT display_name FROM users WHERE id = $1`, [series.owner_user_id]),
    ]);
    const balanceUnits = user.userId ? Number(await getSwypBalanceUnits(user.userId)) : null;
    return NextResponse.json({
        series: toSeriesDto(series, episodes.length, ownerRows.rows[0]?.display_name ?? null),
        episodes: toEpisodeDtos(series, episodes, viewer, progress),
        viewer: { balanceUnits, hasSeasonUnlock: viewer.hasSeasonUnlock, isOwner },
    });
});
```

- [ ] **Step 3: Play + stream proxy**

```ts
// app/api/movies/[slug]/episodes/[n]/play/route.ts
import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { withErrorHandling } from "@/lib/api-handler";
import { getSwypBalanceUnits } from "@/lib/swyp/ledger";
import { getSeriesBySlug, getEpisode, getEpisodeById, listEpisodes } from "@/lib/movies/repository";
import { buildViewerContext } from "@/lib/movies/viewer";
import { canPlay, isFreeEpisode } from "@/lib/movies/access";
import { seasonPriceUnits } from "@/lib/movies/pricing";
import { signStreamToken } from "@/lib/movies/stream-token";
import { MOVIES_STREAM_TOKEN_TTL_S } from "@/lib/movies/config";
import { getStreamSecret } from "@/lib/movies/stream-secret";

export const dynamic = "force-dynamic";

export const GET = withErrorHandling(async function GET(_req: Request, { params }: { params: Promise<{ slug: string; n: string }> }) {
    if (!isEnabled("movies")) return frozenResponse("movies");
    const { slug, n } = await params;
    const episodeNumber = Number(n);
    if (!Number.isInteger(episodeNumber) || episodeNumber < 1) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const series = await getSeriesBySlug(slug);
    if (!series || series.status !== "published") return NextResponse.json({ error: "not_found" }, { status: 404 });
    const episode = await getEpisode(series.id, episodeNumber);
    if (!episode || episode.status !== "published") return NextResponse.json({ error: "not_found" }, { status: 404 });

    const user = await getAuthUser();
    const viewer = await buildViewerContext(user.userId, user.isAdmin, series.id);
    if (!canPlay(viewer, series, episode)) {
        const total = (await listEpisodes(series.id, { publishedOnly: true })).length;
        return NextResponse.json({
            error: "locked",
            priceUnits: series.episode_price_units,
            seasonPriceUnits: seasonPriceUnits(series, total),
            balanceUnits: user.userId ? Number(await getSwypBalanceUnits(user.userId)) : null,
            requireAuth: !user.userId,
        }, { status: 402 });
    }

    const full = await getEpisodeById(episode.id);
    if (!full?.playback_url) return NextResponse.json({ error: "not_ready" }, { status: 409 });

    // Episoadele gratuite: URL-ul public direct (identic cu feed-ul). Cele
    // blocate: doar prin proxy-ul cu token legat de user + episod, expirabil.
    if (isFreeEpisode(series, episode)) {
        return NextResponse.json({ videoId: full.video_id, playbackUrl: full.playback_url, poster: full.thumbnail_url, expiresAt: null });
    }
    const expiresAt = Date.now() + MOVIES_STREAM_TOKEN_TTL_S * 1000;
    const token = signStreamToken({ userId: user.userId ?? "admin", episodeId: episode.id, expiresAt }, getStreamSecret());
    return NextResponse.json({
        videoId: full.video_id,
        playbackUrl: `/api/movies/stream/${token}?p=${encodeURIComponent(full.playback_url)}`,
        poster: full.thumbnail_url,
        expiresAt,
    });
});
```

```ts
// lib/movies/stream-secret.ts
/** Secretul HMAC pentru token-urile de stream — același ca la sesiunile anonime (APP_ENCRYPTION_KEY). */
export function getStreamSecret(): string {
    const key = process.env.APP_ENCRYPTION_KEY || process.env.NEXTAUTH_SECRET || "";
    if (!key) {
        if (process.env.NODE_ENV === "production") throw new Error("APP_ENCRYPTION_KEY missing — refusing to sign stream tokens");
        return "dev-only-stream-secret";
    }
    return key;
}

/** Originile de pe care proxy-ul are voie să tragă media (anti-SSRF). */
export function allowedMediaOrigins(): string[] {
    return [process.env.S3_PUBLIC_URL, process.env.R2_PUBLIC_URL, process.env.S3_UPLOAD_PUBLIC_ENDPOINT]
        .filter((v): v is string => Boolean(v))
        .map((v) => new URL(v).origin);
}
```

```ts
// app/api/movies/stream/[token]/route.ts
import { NextResponse } from "next/server";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { withErrorHandling } from "@/lib/api-handler";
import { rateLimit } from "@/lib/security/rate-limit";
import { verifyStreamToken } from "@/lib/movies/stream-token";
import { rewriteHlsPlaylist, isAllowedMediaUrl } from "@/lib/movies/hls-rewrite";
import { getStreamSecret, allowedMediaOrigins } from "@/lib/movies/stream-secret";
import { getEpisodeById } from "@/lib/movies/repository";

export const dynamic = "force-dynamic";

/**
 * GET /api/movies/stream/[token]?p=<url media>
 * Token-ul (HMAC, user+episod, expiră) + verificarea că `p` este pe o origine
 * media a platformei. Playlist-urile HLS se rescriu ca fiecare segment să
 * treacă tot pe aici; segmentele se transmit ca atare.
 */
export const GET = withErrorHandling(async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
    if (!isEnabled("movies")) return frozenResponse("movies");
    const { token } = await params;
    const payload = verifyStreamToken(token, getStreamSecret());
    if (!payload) return NextResponse.json({ error: "forbidden" }, { status: 403 });

    const rl = await rateLimit("moviesStream", `${payload.userId}:${payload.episodeId}`);
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

    const target = new URL(req.url).searchParams.get("p");
    if (!target || !isAllowedMediaUrl(target, allowedMediaOrigins())) {
        return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    // Token-ul e legat de episod; media cerută trebuie să fie a acelui episod
    // (același director cu playback_url) — altfel un token valid ar servi orice obiect.
    const episode = await getEpisodeById(payload.episodeId);
    if (!episode?.playback_url || !target.startsWith(episode.playback_url.slice(0, episode.playback_url.lastIndexOf("/") + 1))) {
        return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const upstream = await fetch(target, { headers: { range: req.headers.get("range") ?? "" } });
    if (!upstream.ok && upstream.status !== 206) return NextResponse.json({ error: "upstream" }, { status: 502 });

    const contentType = upstream.headers.get("content-type") ?? "";
    const isPlaylist = /mpegurl|m3u8/i.test(contentType) || /\.m3u8(\?|$)/i.test(target);
    if (isPlaylist) {
        const text = await upstream.text();
        const rewritten = rewriteHlsPlaylist(text, target, (abs) => `/api/movies/stream/${token}?p=${encodeURIComponent(abs)}`);
        return new NextResponse(rewritten, { status: 200, headers: { "content-type": "application/vnd.apple.mpegurl", "cache-control": "private, no-store" } });
    }
    const headers = new Headers({ "cache-control": "private, max-age=300" });
    for (const h of ["content-type", "content-length", "content-range", "accept-ranges"]) {
        const v = upstream.headers.get(h); if (v) headers.set(h, v);
    }
    return new NextResponse(upstream.body, { status: upstream.status, headers });
});
```

- [ ] **Step 4: Unlock + progress**

```ts
// app/api/movies/[slug]/unlock/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { withErrorHandling } from "@/lib/api-handler";
import { rateLimit } from "@/lib/security/rate-limit";
import { parseBody } from "@/lib/validation/schemas";
import { getSeriesBySlug } from "@/lib/movies/repository";
import { unlockEpisode, unlockSeason } from "@/lib/movies/unlock";
import { getSwypBalanceUnits } from "@/lib/swyp/ledger";

export const dynamic = "force-dynamic";

const BodySchema = z.union([
    z.object({ episodeId: z.string().uuid() }),
    z.object({ season: z.literal(true) }),
]);

const FAILURE_STATUS = { not_found: 404, already_free: 409, series_not_published: 404, insufficient_balance: 402 } as const;

export const POST = withErrorHandling(async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
    if (!isEnabled("movies")) return frozenResponse("movies");
    const user = await getAuthUser();
    if (!user.userId) return NextResponse.json({ error: "auth_required" }, { status: 401 });
    const rl = await rateLimit("moviesUnlock", user.userId);
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

    const { slug } = await params;
    const series = await getSeriesBySlug(slug);
    if (!series) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const parsed = parseBody(BodySchema, await req.json().catch(() => null));
    if (!parsed.ok) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

    const result = "episodeId" in parsed.data
        ? await unlockEpisode({ userId: user.userId, episodeId: parsed.data.episodeId })
        : await unlockSeason({ userId: user.userId, seriesId: series.id });

    if (!result.ok) {
        return NextResponse.json({ error: result.reason, balanceUnits: Number(await getSwypBalanceUnits(user.userId)) }, { status: FAILURE_STATUS[result.reason] });
    }
    return NextResponse.json({ ...result, balanceUnits: Number(await getSwypBalanceUnits(user.userId)) });
});
```

```ts
// app/api/movies/progress/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { withErrorHandling } from "@/lib/api-handler";
import { rateLimit } from "@/lib/security/rate-limit";
import { parseBody } from "@/lib/validation/schemas";
import { upsertProgress } from "@/lib/movies/repository";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
    episodeId: z.string().uuid(),
    positionMs: z.coerce.number().int().min(0).max(24 * 3_600_000),
    completed: z.boolean().default(false),
});

export const POST = withErrorHandling(async function POST(req: Request) {
    if (!isEnabled("movies")) return frozenResponse("movies");
    const user = await getAuthUser();
    if (!user.userId) return NextResponse.json({ ok: false, error: "auth_required" }, { status: 401 });
    const rl = await rateLimit("moviesProgress", user.userId);
    if (!rl.success) return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
    const parsed = parseBody(BodySchema, await req.json().catch(() => null));
    if (!parsed.ok) return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
    await upsertProgress(user.userId, parsed.data.episodeId, parsed.data.positionMs, parsed.data.completed);
    return NextResponse.json({ ok: true });
});
```

- [ ] **Step 5: Gate + commit**

Run: `npx tsc --noEmit --incremental false` → 0; `npx eslint app/api/movies lib/movies` → 0 erori.
```bash
git add lib/movies/viewer.ts lib/movies/dto.ts lib/movies/stream-secret.ts app/api/movies
git commit -m "feat(movies): API public — catalog, serial, play cu paywall, proxy HLS cu token, unlock, progres"
```

---

### Task 7: API creator (studio) și admin

**Files:**
- Create: `app/api/creator/movies/route.ts`, `app/api/creator/movies/[id]/route.ts`, `app/api/creator/movies/[id]/episodes/route.ts`
- Create: `app/api/admin/movies/route.ts`, `app/api/admin/movies/[id]/route.ts`, `app/api/admin/movies/publishers/route.ts`
- Create: `lib/movies/slug.ts`

**Interfaces:**
- Consumes: `getCreatorUserId` (`lib/creator/session.ts`), `requireAuth(req, ["admin"])` (`lib/auth/getAuthUser.ts`), repository din Task 4, `clampEpisodePrice`.
- Produces: `slugifySeriesTitle(title: string): string` (kebab, ASCII, ≤ 80) și endpoint-urile de mai jos.

- [ ] **Step 1: Slug**

```ts
// lib/movies/slug.ts
export function slugifySeriesTitle(title: string): string {
    const base = title.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70);
    return `${base || "serial"}-${Date.now().toString(36)}`;
}
```

- [ ] **Step 2: Creator API**

```ts
// app/api/creator/movies/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { getCreatorUserId } from "@/lib/creator/session";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { withErrorHandling } from "@/lib/api-handler";
import { rateLimit } from "@/lib/security/rate-limit";
import { parseBody } from "@/lib/validation/schemas";
import { createSeries, isPublisher, listSeriesForOwner, creatorShareTotals } from "@/lib/movies/repository";
import { clampEpisodePrice } from "@/lib/movies/pricing";
import { slugifySeriesTitle } from "@/lib/movies/slug";
import { MOVIES_DEFAULT_EPISODE_PRICE_UNITS, MOVIES_DEFAULT_FREE_EPISODES, MOVIES_MAX_FREE_EPISODES } from "@/lib/movies/config";
import { LOCALES } from "@/lib/i18n/config";

export const dynamic = "force-dynamic";

const CreateSchema = z.object({
    title: z.string().trim().min(2).max(120),
    synopsis: z.string().trim().max(2000).default(""),
    genres: z.array(z.string().trim().min(2).max(30)).max(5).default([]),
    languageCode: z.enum(LOCALES).default("ro"),
    coverUrl: z.string().url().max(500).nullable().default(null),
    posterUrl: z.string().url().max(500).nullable().default(null),
    freeEpisodes: z.coerce.number().int().min(0).max(MOVIES_MAX_FREE_EPISODES).default(MOVIES_DEFAULT_FREE_EPISODES),
    episodePriceUnits: z.coerce.number().int().default(MOVIES_DEFAULT_EPISODE_PRICE_UNITS),
    isAdult: z.boolean().default(false),
    licenseNote: z.string().trim().max(1000).nullable().default(null),
});

export const GET = withErrorHandling(async function GET() {
    if (!isEnabled("movies")) return frozenResponse("movies");
    const userId = await getCreatorUserId();
    if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const [publisher, series, earnings] = await Promise.all([isPublisher(userId), listSeriesForOwner(userId), creatorShareTotals(userId)]);
    return NextResponse.json({ publisher, series, earnings });
});

export const POST = withErrorHandling(async function POST(req: Request) {
    if (!isEnabled("movies")) return frozenResponse("movies");
    const userId = await getCreatorUserId();
    if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (!(await isPublisher(userId))) return NextResponse.json({ error: "not_a_publisher" }, { status: 403 });
    const rl = await rateLimit("moviesPublish", userId);
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    const parsed = parseBody(CreateSchema, await req.json().catch(() => null));
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const d = parsed.data;
    const series = await createSeries({
        ownerUserId: userId, slug: slugifySeriesTitle(d.title), title: d.title, synopsis: d.synopsis, genres: d.genres,
        languageCode: d.languageCode, coverUrl: d.coverUrl, posterUrl: d.posterUrl, freeEpisodes: d.freeEpisodes,
        episodePriceUnits: clampEpisodePrice(d.episodePriceUnits), isAdult: d.isAdult, licenseNote: d.licenseNote,
    });
    return NextResponse.json({ series }, { status: 201 });
});
```

```ts
// app/api/creator/movies/[id]/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { getCreatorUserId } from "@/lib/creator/session";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { withErrorHandling } from "@/lib/api-handler";
import { parseBody } from "@/lib/validation/schemas";
import { getSeriesById, listEpisodes, updateSeries } from "@/lib/movies/repository";
import { clampEpisodePrice } from "@/lib/movies/pricing";
import { MOVIES_MAX_FREE_EPISODES } from "@/lib/movies/config";

export const dynamic = "force-dynamic";

const PatchSchema = z.object({
    title: z.string().trim().min(2).max(120).optional(),
    synopsis: z.string().trim().max(2000).optional(),
    genres: z.array(z.string().trim().min(2).max(30)).max(5).optional(),
    coverUrl: z.string().url().max(500).nullable().optional(),
    posterUrl: z.string().url().max(500).nullable().optional(),
    freeEpisodes: z.coerce.number().int().min(0).max(MOVIES_MAX_FREE_EPISODES).optional(),
    episodePriceUnits: z.coerce.number().int().optional(),
    isAdult: z.boolean().optional(),
    licenseNote: z.string().trim().max(1000).nullable().optional(),
    /** Creatorul poate doar trimite la review sau retrage în draft; publicarea e a adminului. */
    status: z.enum(["draft", "pending_review"]).optional(),
});

export const GET = withErrorHandling(async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
    if (!isEnabled("movies")) return frozenResponse("movies");
    const userId = await getCreatorUserId();
    if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const { id } = await params;
    const series = await getSeriesById(id);
    if (!series || series.owner_user_id !== userId) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ series, episodes: await listEpisodes(id) });
});

export const PATCH = withErrorHandling(async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
    if (!isEnabled("movies")) return frozenResponse("movies");
    const userId = await getCreatorUserId();
    if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const { id } = await params;
    const parsed = parseBody(PatchSchema, await req.json().catch(() => null));
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const patch = { ...parsed.data, ...(parsed.data.episodePriceUnits !== undefined ? { episodePriceUnits: clampEpisodePrice(parsed.data.episodePriceUnits) } : {}) };
    if (patch.status === "pending_review") {
        const current = await getSeriesById(id);
        if (!current?.license_note) return NextResponse.json({ error: "license_note_required" }, { status: 422 });
    }
    const series = await updateSeries(id, userId, patch);
    if (!series) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ series });
});
```

```ts
// app/api/creator/movies/[id]/episodes/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { getCreatorUserId } from "@/lib/creator/session";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { withErrorHandling } from "@/lib/api-handler";
import { parseBody } from "@/lib/validation/schemas";
import { addEpisode, getSeriesById, listEpisodes, ownsReadyVideo } from "@/lib/movies/repository";
import { MOVIES_MAX_EPISODE_DURATION_MS } from "@/lib/movies/config";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
    videoId: z.string().uuid(),
    title: z.string().trim().min(1).max(120),
    episodeNumber: z.coerce.number().int().min(1).max(500).optional(),
});

export const POST = withErrorHandling(async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
    if (!isEnabled("movies")) return frozenResponse("movies");
    const userId = await getCreatorUserId();
    if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const { id } = await params;
    const series = await getSeriesById(id);
    if (!series || series.owner_user_id !== userId) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const parsed = parseBody(BodySchema, await req.json().catch(() => null));
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const video = await ownsReadyVideo(userId, parsed.data.videoId);
    if (!video) return NextResponse.json({ error: "video_not_ready_or_not_owned" }, { status: 422 });
    if (video.duration_ms && video.duration_ms > MOVIES_MAX_EPISODE_DURATION_MS) {
        return NextResponse.json({ error: "episode_too_long", maxDurationMs: MOVIES_MAX_EPISODE_DURATION_MS }, { status: 422 });
    }
    const existing = await listEpisodes(id);
    const episodeNumber = parsed.data.episodeNumber ?? (existing.at(-1)?.episode_number ?? 0) + 1;
    if (existing.some((e) => e.episode_number === episodeNumber)) return NextResponse.json({ error: "episode_number_taken" }, { status: 409 });
    if (existing.some((e) => e.video_id === parsed.data.videoId)) return NextResponse.json({ error: "video_already_used" }, { status: 409 });

    const episode = await addEpisode({ seriesId: id, episodeNumber, videoId: parsed.data.videoId, title: parsed.data.title, durationMs: video.duration_ms });
    return NextResponse.json({ episode }, { status: 201 });
});
```

- [ ] **Step 3: Admin API**

```ts
// app/api/admin/movies/route.ts
import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/getAuthUser";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { withErrorHandling } from "@/lib/api-handler";
import { listSeriesForAdmin } from "@/lib/movies/repository";
import type { SeriesStatus } from "@/lib/movies/types";

export const dynamic = "force-dynamic";
const STATUSES: SeriesStatus[] = ["draft", "pending_review", "published", "archived"];

export const GET = withErrorHandling(async function GET(req: Request) {
    if (!isEnabled("movies")) return frozenResponse("movies");
    const auth = await requireAuth(req, ["admin"]);
    if (auth instanceof NextResponse) return auth;
    const raw = new URL(req.url).searchParams.get("status");
    const status = STATUSES.includes(raw as SeriesStatus) ? (raw as SeriesStatus) : undefined;
    return NextResponse.json({ series: await listSeriesForAdmin(status) });
});
```

```ts
// app/api/admin/movies/[id]/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/getAuthUser";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { withErrorHandling } from "@/lib/api-handler";
import { parseBody } from "@/lib/validation/schemas";
import { dbQuery } from "@/lib/db";
import { getSeriesById, listEpisodes, updateSeries } from "@/lib/movies/repository";
import { clampEpisodePrice } from "@/lib/movies/pricing";
import { MOVIES_MAX_FREE_EPISODES } from "@/lib/movies/config";

export const dynamic = "force-dynamic";

const PatchSchema = z.object({
    status: z.enum(["draft", "pending_review", "published", "archived"]).optional(),
    freeEpisodes: z.coerce.number().int().min(0).max(MOVIES_MAX_FREE_EPISODES).optional(),
    episodePriceUnits: z.coerce.number().int().optional(),
    isAdult: z.boolean().optional(),
    trailerVideoId: z.string().uuid().nullable().optional(),
});

export const GET = withErrorHandling(async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
    if (!isEnabled("movies")) return frozenResponse("movies");
    const auth = await requireAuth(req, ["admin"]);
    if (auth instanceof NextResponse) return auth;
    const { id } = await params;
    const series = await getSeriesById(id);
    if (!series) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ series, episodes: await listEpisodes(id) });
});

export const PATCH = withErrorHandling(async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
    if (!isEnabled("movies")) return frozenResponse("movies");
    const auth = await requireAuth(req, ["admin"]);
    if (auth instanceof NextResponse) return auth;
    const { id } = await params;
    const parsed = parseBody(PatchSchema, await req.json().catch(() => null));
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

    if (parsed.data.status === "published") {
        // Publicarea cere: license_note, cel puțin un episod, toate episoadele aprobate la moderare.
        const series = await getSeriesById(id);
        if (!series?.license_note) return NextResponse.json({ error: "license_note_required" }, { status: 422 });
        const { rows } = await dbQuery<{ total: string; approved: string }>(
            `SELECT COUNT(*)::text AS total,
                    COUNT(*) FILTER (WHERE v.moderation_status = 'approved' AND v.status = 'ready')::text AS approved
               FROM movie_episodes e JOIN videos v ON v.id = e.video_id WHERE e.series_id = $1`,
            [id],
        );
        if (Number(rows[0]?.total ?? 0) === 0) return NextResponse.json({ error: "no_episodes" }, { status: 422 });
        if (rows[0].total !== rows[0].approved) return NextResponse.json({ error: "episodes_not_approved" }, { status: 422 });
    }
    const patch = { ...parsed.data, ...(parsed.data.episodePriceUnits !== undefined ? { episodePriceUnits: clampEpisodePrice(parsed.data.episodePriceUnits) } : {}) };
    const series = await updateSeries(id, null, patch);
    if (!series) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ series });
});
```

```ts
// app/api/admin/movies/publishers/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/getAuthUser";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { withErrorHandling } from "@/lib/api-handler";
import { parseBody } from "@/lib/validation/schemas";
import { dbQuery } from "@/lib/db";

export const dynamic = "force-dynamic";

export const GET = withErrorHandling(async function GET(req: Request) {
    if (!isEnabled("movies")) return frozenResponse("movies");
    const auth = await requireAuth(req, ["admin"]);
    if (auth instanceof NextResponse) return auth;
    const { rows } = await dbQuery(
        `SELECT p.user_id, p.approved_at, p.note, u.display_name, u.username, u.email
           FROM movie_publishers p JOIN users u ON u.id = p.user_id ORDER BY p.approved_at DESC`,
    );
    return NextResponse.json({ publishers: rows });
});

const BodySchema = z.object({ userId: z.string().uuid(), note: z.string().trim().max(500).optional() });

export const POST = withErrorHandling(async function POST(req: Request) {
    if (!isEnabled("movies")) return frozenResponse("movies");
    const auth = await requireAuth(req, ["admin"]);
    if (auth instanceof NextResponse) return auth;
    const parsed = parseBody(BodySchema, await req.json().catch(() => null));
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    await dbQuery(
        `INSERT INTO movie_publishers (user_id, approved_by, note) VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE SET note = EXCLUDED.note`,
        [parsed.data.userId, auth.userId, parsed.data.note ?? null],
    );
    return NextResponse.json({ ok: true }, { status: 201 });
});

export const DELETE = withErrorHandling(async function DELETE(req: Request) {
    if (!isEnabled("movies")) return frozenResponse("movies");
    const auth = await requireAuth(req, ["admin"]);
    if (auth instanceof NextResponse) return auth;
    const userId = new URL(req.url).searchParams.get("userId");
    if (!userId) return NextResponse.json({ error: "invalid_query" }, { status: 400 });
    await dbQuery(`DELETE FROM movie_publishers WHERE user_id = $1`, [userId]);
    return NextResponse.json({ ok: true });
});
```

- [ ] **Step 4: Gate + commit**

Run: `npx tsc --noEmit --incremental false`; `npx eslint app/api/creator/movies app/api/admin/movies lib/movies/slug.ts`.
```bash
git add lib/movies/slug.ts app/api/creator/movies app/api/admin/movies
git commit -m "feat(movies): API creator (studio) și admin (publisheri, review, publicare)"
```

---

### Task 8: Traduceri (namespace `movies` + `meta`), 7 locale

**Files:**
- Modify: `messages/ro.json`, `messages/en.json`, `messages/de.json`, `messages/es.json`, `messages/fr.json`, `messages/it.json`, `messages/pt.json`
- Create (temporar, rulat o dată apoi șters): `scripts/tmp-movies-i18n.mjs`

**Interfaces:**
- Produces cheile `movies.*` și `meta.moviesTitle`, `meta.moviesDescription` folosite de Task 9–14.

- [ ] **Step 1: Scriptul care adaugă cheile în toate locale-le**

```js
// scripts/tmp-movies-i18n.mjs — rulează: node scripts/tmp-movies-i18n.mjs ; apoi șterge fișierul.
import fs from "node:fs";
const T = {
  ro: { movies: { title: "Swypik Movies", tagline: "Seriale scurte, verticale, de urmărit dintr-o suflare", watchNow: "Vezi acum", continueWatching: "Continuă să vezi", continueEpisode: "Continuă ep. {n}", startEpisode: "Vezi episodul 1", trending: "Top 10 în România", newReleases: "Noutăți", allGenres: "Toate genurile", episodes: "{count} episoade", episode: "Ep. {n}", episodeOf: "Ep. {n}/{total}", free: "Gratuit", locked: "Blocat", priceSwyp: "{amount} SWYP", unlockEpisode: "Deblochează episodul", unlockSeason: "Deblochează sezonul", seasonDiscount: "−{pct}% față de episoade separate", yourBalance: "Soldul tău: {amount} SWYP", insufficient: "Nu ai suficient SWYP. Câștigă din minare sau misiuni.", loginToUnlock: "Conectează-te pentru a debloca", unlocking: "Se deblochează...", unlocked: "Deblocat! Se încarcă episodul...", nextEpisode: "Episodul următor", shopScene: "Cumpără din scenă", synopsis: "Sinopsis", by: "de {name}", official: "Swypik Original", empty: "Nu există seriale publicate încă.", loadError: "Nu am putut încărca serialul.", genres: "Genuri", freeEpisodesLabel: "Primele {n} episoade gratuite", adult: "18+", back: "Înapoi", mute: "Fără sunet", unmute: "Cu sunet", studio: "Studio Movies", studioIntro: "Creează seriale verticale și câștigă SWYP la fiecare deblocare.", notPublisher: "Contul tău nu este încă aprobat ca publisher Movies. Cere aprobarea din secțiunea de suport.", newSeries: "Serial nou", seriesTitle: "Titlu", seriesSynopsis: "Sinopsis", seriesGenres: "Genuri (separate prin virgulă)", posterUrl: "URL poster (9:16)", coverUrl: "URL copertă (16:9)", freeEpisodesField: "Episoade gratuite", episodePrice: "Preț per episod (SWYP)", licenseNote: "Notă licență (obligatorie la publicare)", isAdultField: "Conținut 18+", create: "Creează", save: "Salvează", submitReview: "Trimite la review", addEpisode: "Adaugă episod", pickVideo: "Alege un clip gata procesat", episodeTitle: "Titlu episod", earnings: "Câștiguri Movies", earningsUnlocks: "{count} deblocări", statusDraft: "Ciornă", statusPendingReview: "În review", statusPublished: "Publicat", statusArchived: "Arhivat", adminTitle: "Movies — administrare", publishers: "Publisheri", approvePublisher: "Aprobă publisher (ID user)", publish: "Publică", archive: "Arhivează", backToDraft: "Înapoi în ciornă", saved: "Salvat.", error: "A apărut o eroare." },
        meta: { moviesTitle: "Swypik Movies — seriale scurte verticale", moviesDescription: "Micro-seriale verticale, primele episoade gratuite, restul deblocate cu SWYP. Cumpără ce vezi în scenă." } },
  en: { movies: { title: "Swypik Movies", tagline: "Short vertical series you binge in one breath", watchNow: "Watch now", continueWatching: "Continue watching", continueEpisode: "Continue ep. {n}", startEpisode: "Watch episode 1", trending: "Top 10 in Romania", newReleases: "New releases", allGenres: "All genres", episodes: "{count} episodes", episode: "Ep. {n}", episodeOf: "Ep. {n}/{total}", free: "Free", locked: "Locked", priceSwyp: "{amount} SWYP", unlockEpisode: "Unlock episode", unlockSeason: "Unlock season", seasonDiscount: "−{pct}% vs. single episodes", yourBalance: "Your balance: {amount} SWYP", insufficient: "Not enough SWYP. Earn more from mining or missions.", loginToUnlock: "Sign in to unlock", unlocking: "Unlocking...", unlocked: "Unlocked! Loading the episode...", nextEpisode: "Next episode", shopScene: "Shop the scene", synopsis: "Synopsis", by: "by {name}", official: "Swypik Original", empty: "No series published yet.", loadError: "Could not load this series.", genres: "Genres", freeEpisodesLabel: "First {n} episodes free", adult: "18+", back: "Back", mute: "Mute", unmute: "Unmute", studio: "Movies Studio", studioIntro: "Create vertical series and earn SWYP on every unlock.", notPublisher: "Your account is not approved as a Movies publisher yet. Request approval from support.", newSeries: "New series", seriesTitle: "Title", seriesSynopsis: "Synopsis", seriesGenres: "Genres (comma separated)", posterUrl: "Poster URL (9:16)", coverUrl: "Cover URL (16:9)", freeEpisodesField: "Free episodes", episodePrice: "Price per episode (SWYP)", licenseNote: "License note (required to publish)", isAdultField: "18+ content", create: "Create", save: "Save", submitReview: "Submit for review", addEpisode: "Add episode", pickVideo: "Pick a processed clip", episodeTitle: "Episode title", earnings: "Movies earnings", earningsUnlocks: "{count} unlocks", statusDraft: "Draft", statusPendingReview: "In review", statusPublished: "Published", statusArchived: "Archived", adminTitle: "Movies — admin", publishers: "Publishers", approvePublisher: "Approve publisher (user ID)", publish: "Publish", archive: "Archive", backToDraft: "Back to draft", saved: "Saved.", error: "Something went wrong." },
        meta: { moviesTitle: "Swypik Movies — short vertical series", moviesDescription: "Vertical micro-series, first episodes free, the rest unlocked with SWYP. Shop what you see in the scene." } },
  de: { movies: { title: "Swypik Movies", tagline: "Kurze vertikale Serien zum Durchschauen", watchNow: "Jetzt ansehen", continueWatching: "Weiterschauen", continueEpisode: "Weiter mit Ep. {n}", startEpisode: "Episode 1 ansehen", trending: "Top 10 in Rumänien", newReleases: "Neu", allGenres: "Alle Genres", episodes: "{count} Episoden", episode: "Ep. {n}", episodeOf: "Ep. {n}/{total}", free: "Kostenlos", locked: "Gesperrt", priceSwyp: "{amount} SWYP", unlockEpisode: "Episode freischalten", unlockSeason: "Staffel freischalten", seasonDiscount: "−{pct}% gegenüber Einzelepisoden", yourBalance: "Dein Guthaben: {amount} SWYP", insufficient: "Nicht genug SWYP. Verdiene mehr durch Mining oder Missionen.", loginToUnlock: "Anmelden zum Freischalten", unlocking: "Wird freigeschaltet...", unlocked: "Freigeschaltet! Episode wird geladen...", nextEpisode: "Nächste Episode", shopScene: "Aus der Szene kaufen", synopsis: "Inhalt", by: "von {name}", official: "Swypik Original", empty: "Noch keine Serien veröffentlicht.", loadError: "Serie konnte nicht geladen werden.", genres: "Genres", freeEpisodesLabel: "Die ersten {n} Episoden kostenlos", adult: "18+", back: "Zurück", mute: "Stumm", unmute: "Ton an", studio: "Movies Studio", studioIntro: "Erstelle vertikale Serien und verdiene SWYP bei jeder Freischaltung.", notPublisher: "Dein Konto ist noch nicht als Movies-Publisher freigegeben. Bitte den Support um Freigabe.", newSeries: "Neue Serie", seriesTitle: "Titel", seriesSynopsis: "Inhalt", seriesGenres: "Genres (kommagetrennt)", posterUrl: "Poster-URL (9:16)", coverUrl: "Cover-URL (16:9)", freeEpisodesField: "Kostenlose Episoden", episodePrice: "Preis pro Episode (SWYP)", licenseNote: "Lizenzhinweis (zum Veröffentlichen erforderlich)", isAdultField: "Inhalt 18+", create: "Erstellen", save: "Speichern", submitReview: "Zur Prüfung einreichen", addEpisode: "Episode hinzufügen", pickVideo: "Fertig verarbeiteten Clip wählen", episodeTitle: "Episodentitel", earnings: "Movies-Einnahmen", earningsUnlocks: "{count} Freischaltungen", statusDraft: "Entwurf", statusPendingReview: "In Prüfung", statusPublished: "Veröffentlicht", statusArchived: "Archiviert", adminTitle: "Movies — Verwaltung", publishers: "Publisher", approvePublisher: "Publisher freigeben (User-ID)", publish: "Veröffentlichen", archive: "Archivieren", backToDraft: "Zurück zum Entwurf", saved: "Gespeichert.", error: "Etwas ist schiefgelaufen." },
        meta: { moviesTitle: "Swypik Movies — kurze vertikale Serien", moviesDescription: "Vertikale Mikro-Serien, erste Episoden kostenlos, der Rest mit SWYP freischaltbar. Kaufe, was du in der Szene siehst." } },
  es: { movies: { title: "Swypik Movies", tagline: "Series cortas verticales para ver de un tirón", watchNow: "Ver ahora", continueWatching: "Seguir viendo", continueEpisode: "Continuar ep. {n}", startEpisode: "Ver episodio 1", trending: "Top 10 en Rumanía", newReleases: "Novedades", allGenres: "Todos los géneros", episodes: "{count} episodios", episode: "Ep. {n}", episodeOf: "Ep. {n}/{total}", free: "Gratis", locked: "Bloqueado", priceSwyp: "{amount} SWYP", unlockEpisode: "Desbloquear episodio", unlockSeason: "Desbloquear temporada", seasonDiscount: "−{pct}% frente a episodios sueltos", yourBalance: "Tu saldo: {amount} SWYP", insufficient: "No tienes suficiente SWYP. Gana más con minería o misiones.", loginToUnlock: "Inicia sesión para desbloquear", unlocking: "Desbloqueando...", unlocked: "¡Desbloqueado! Cargando el episodio...", nextEpisode: "Siguiente episodio", shopScene: "Compra lo de la escena", synopsis: "Sinopsis", by: "de {name}", official: "Swypik Original", empty: "Aún no hay series publicadas.", loadError: "No se pudo cargar la serie.", genres: "Géneros", freeEpisodesLabel: "Los primeros {n} episodios gratis", adult: "18+", back: "Atrás", mute: "Silenciar", unmute: "Activar sonido", studio: "Movies Studio", studioIntro: "Crea series verticales y gana SWYP con cada desbloqueo.", notPublisher: "Tu cuenta aún no está aprobada como publisher de Movies. Pide la aprobación a soporte.", newSeries: "Nueva serie", seriesTitle: "Título", seriesSynopsis: "Sinopsis", seriesGenres: "Géneros (separados por comas)", posterUrl: "URL del póster (9:16)", coverUrl: "URL de portada (16:9)", freeEpisodesField: "Episodios gratis", episodePrice: "Precio por episodio (SWYP)", licenseNote: "Nota de licencia (obligatoria para publicar)", isAdultField: "Contenido 18+", create: "Crear", save: "Guardar", submitReview: "Enviar a revisión", addEpisode: "Añadir episodio", pickVideo: "Elige un clip ya procesado", episodeTitle: "Título del episodio", earnings: "Ganancias de Movies", earningsUnlocks: "{count} desbloqueos", statusDraft: "Borrador", statusPendingReview: "En revisión", statusPublished: "Publicado", statusArchived: "Archivado", adminTitle: "Movies — administración", publishers: "Publishers", approvePublisher: "Aprobar publisher (ID de usuario)", publish: "Publicar", archive: "Archivar", backToDraft: "Volver a borrador", saved: "Guardado.", error: "Algo salió mal." },
        meta: { moviesTitle: "Swypik Movies — series cortas verticales", moviesDescription: "Microseries verticales, primeros episodios gratis, el resto se desbloquea con SWYP. Compra lo que ves en la escena." } },
  fr: { movies: { title: "Swypik Movies", tagline: "Des séries courtes verticales à dévorer d'une traite", watchNow: "Regarder", continueWatching: "Reprendre", continueEpisode: "Reprendre l'ép. {n}", startEpisode: "Voir l'épisode 1", trending: "Top 10 en Roumanie", newReleases: "Nouveautés", allGenres: "Tous les genres", episodes: "{count} épisodes", episode: "Ép. {n}", episodeOf: "Ép. {n}/{total}", free: "Gratuit", locked: "Verrouillé", priceSwyp: "{amount} SWYP", unlockEpisode: "Débloquer l'épisode", unlockSeason: "Débloquer la saison", seasonDiscount: "−{pct}% par rapport aux épisodes seuls", yourBalance: "Ton solde : {amount} SWYP", insufficient: "Pas assez de SWYP. Gagnes-en via le minage ou les missions.", loginToUnlock: "Connecte-toi pour débloquer", unlocking: "Déblocage...", unlocked: "Débloqué ! Chargement de l'épisode...", nextEpisode: "Épisode suivant", shopScene: "Acheter la scène", synopsis: "Synopsis", by: "par {name}", official: "Swypik Original", empty: "Aucune série publiée pour l'instant.", loadError: "Impossible de charger la série.", genres: "Genres", freeEpisodesLabel: "Les {n} premiers épisodes gratuits", adult: "18+", back: "Retour", mute: "Couper le son", unmute: "Activer le son", studio: "Movies Studio", studioIntro: "Crée des séries verticales et gagne des SWYP à chaque déblocage.", notPublisher: "Ton compte n'est pas encore approuvé comme éditeur Movies. Demande l'approbation au support.", newSeries: "Nouvelle série", seriesTitle: "Titre", seriesSynopsis: "Synopsis", seriesGenres: "Genres (séparés par des virgules)", posterUrl: "URL de l'affiche (9:16)", coverUrl: "URL de la couverture (16:9)", freeEpisodesField: "Épisodes gratuits", episodePrice: "Prix par épisode (SWYP)", licenseNote: "Note de licence (obligatoire pour publier)", isAdultField: "Contenu 18+", create: "Créer", save: "Enregistrer", submitReview: "Soumettre à la relecture", addEpisode: "Ajouter un épisode", pickVideo: "Choisir un clip déjà traité", episodeTitle: "Titre de l'épisode", earnings: "Revenus Movies", earningsUnlocks: "{count} déblocages", statusDraft: "Brouillon", statusPendingReview: "En relecture", statusPublished: "Publié", statusArchived: "Archivé", adminTitle: "Movies — administration", publishers: "Éditeurs", approvePublisher: "Approuver un éditeur (ID utilisateur)", publish: "Publier", archive: "Archiver", backToDraft: "Remettre en brouillon", saved: "Enregistré.", error: "Une erreur est survenue." },
        meta: { moviesTitle: "Swypik Movies — séries courtes verticales", moviesDescription: "Micro-séries verticales, premiers épisodes gratuits, le reste débloqué avec des SWYP. Achète ce que tu vois dans la scène." } },
  it: { movies: { title: "Swypik Movies", tagline: "Serie brevi verticali da guardare tutte d'un fiato", watchNow: "Guarda ora", continueWatching: "Continua a guardare", continueEpisode: "Continua ep. {n}", startEpisode: "Guarda l'episodio 1", trending: "Top 10 in Romania", newReleases: "Novità", allGenres: "Tutti i generi", episodes: "{count} episodi", episode: "Ep. {n}", episodeOf: "Ep. {n}/{total}", free: "Gratis", locked: "Bloccato", priceSwyp: "{amount} SWYP", unlockEpisode: "Sblocca episodio", unlockSeason: "Sblocca stagione", seasonDiscount: "−{pct}% rispetto ai singoli episodi", yourBalance: "Il tuo saldo: {amount} SWYP", insufficient: "SWYP insufficienti. Guadagnane con il mining o le missioni.", loginToUnlock: "Accedi per sbloccare", unlocking: "Sblocco in corso...", unlocked: "Sbloccato! Caricamento dell'episodio...", nextEpisode: "Prossimo episodio", shopScene: "Compra dalla scena", synopsis: "Sinossi", by: "di {name}", official: "Swypik Original", empty: "Nessuna serie pubblicata ancora.", loadError: "Impossibile caricare la serie.", genres: "Generi", freeEpisodesLabel: "I primi {n} episodi gratis", adult: "18+", back: "Indietro", mute: "Silenzia", unmute: "Attiva audio", studio: "Movies Studio", studioIntro: "Crea serie verticali e guadagna SWYP a ogni sblocco.", notPublisher: "Il tuo account non è ancora approvato come publisher Movies. Chiedi l'approvazione al supporto.", newSeries: "Nuova serie", seriesTitle: "Titolo", seriesSynopsis: "Sinossi", seriesGenres: "Generi (separati da virgola)", posterUrl: "URL poster (9:16)", coverUrl: "URL copertina (16:9)", freeEpisodesField: "Episodi gratuiti", episodePrice: "Prezzo per episodio (SWYP)", licenseNote: "Nota licenza (obbligatoria per pubblicare)", isAdultField: "Contenuto 18+", create: "Crea", save: "Salva", submitReview: "Invia in revisione", addEpisode: "Aggiungi episodio", pickVideo: "Scegli una clip già elaborata", episodeTitle: "Titolo episodio", earnings: "Guadagni Movies", earningsUnlocks: "{count} sblocchi", statusDraft: "Bozza", statusPendingReview: "In revisione", statusPublished: "Pubblicato", statusArchived: "Archiviato", adminTitle: "Movies — amministrazione", publishers: "Publisher", approvePublisher: "Approva publisher (ID utente)", publish: "Pubblica", archive: "Archivia", backToDraft: "Torna in bozza", saved: "Salvato.", error: "Si è verificato un errore." },
        meta: { moviesTitle: "Swypik Movies — serie brevi verticali", moviesDescription: "Micro-serie verticali, primi episodi gratis, il resto si sblocca con SWYP. Compra ciò che vedi nella scena." } },
  pt: { movies: { title: "Swypik Movies", tagline: "Séries curtas verticais para ver de uma só vez", watchNow: "Ver agora", continueWatching: "Continuar a ver", continueEpisode: "Continuar ep. {n}", startEpisode: "Ver episódio 1", trending: "Top 10 na Roménia", newReleases: "Novidades", allGenres: "Todos os géneros", episodes: "{count} episódios", episode: "Ep. {n}", episodeOf: "Ep. {n}/{total}", free: "Grátis", locked: "Bloqueado", priceSwyp: "{amount} SWYP", unlockEpisode: "Desbloquear episódio", unlockSeason: "Desbloquear temporada", seasonDiscount: "−{pct}% face a episódios avulsos", yourBalance: "O teu saldo: {amount} SWYP", insufficient: "Não tens SWYP suficiente. Ganha mais com mineração ou missões.", loginToUnlock: "Inicia sessão para desbloquear", unlocking: "A desbloquear...", unlocked: "Desbloqueado! A carregar o episódio...", nextEpisode: "Próximo episódio", shopScene: "Comprar da cena", synopsis: "Sinopse", by: "de {name}", official: "Swypik Original", empty: "Ainda não há séries publicadas.", loadError: "Não foi possível carregar a série.", genres: "Géneros", freeEpisodesLabel: "Os primeiros {n} episódios grátis", adult: "18+", back: "Voltar", mute: "Sem som", unmute: "Com som", studio: "Movies Studio", studioIntro: "Cria séries verticais e ganha SWYP em cada desbloqueio.", notPublisher: "A tua conta ainda não está aprovada como publisher de Movies. Pede aprovação ao suporte.", newSeries: "Nova série", seriesTitle: "Título", seriesSynopsis: "Sinopse", seriesGenres: "Géneros (separados por vírgula)", posterUrl: "URL do poster (9:16)", coverUrl: "URL da capa (16:9)", freeEpisodesField: "Episódios grátis", episodePrice: "Preço por episódio (SWYP)", licenseNote: "Nota de licença (obrigatória para publicar)", isAdultField: "Conteúdo 18+", create: "Criar", save: "Guardar", submitReview: "Enviar para revisão", addEpisode: "Adicionar episódio", pickVideo: "Escolhe um clip já processado", episodeTitle: "Título do episódio", earnings: "Ganhos Movies", earningsUnlocks: "{count} desbloqueios", statusDraft: "Rascunho", statusPendingReview: "Em revisão", statusPublished: "Publicado", statusArchived: "Arquivado", adminTitle: "Movies — administração", publishers: "Publishers", approvePublisher: "Aprovar publisher (ID de utilizador)", publish: "Publicar", archive: "Arquivar", backToDraft: "Voltar a rascunho", saved: "Guardado.", error: "Ocorreu um erro." },
        meta: { moviesTitle: "Swypik Movies — séries curtas verticais", moviesDescription: "Micro-séries verticais, primeiros episódios grátis, o resto desbloqueado com SWYP. Compra o que vês na cena." } },
};
for (const [loc, patch] of Object.entries(T)) {
  const p = `messages/${loc}.json`;
  const m = JSON.parse(fs.readFileSync(p, "utf8"));
  for (const [ns, keys] of Object.entries(patch)) { m[ns] = m[ns] || {}; Object.assign(m[ns], keys); }
  fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
}
console.log("movies i18n added");
```

- [ ] **Step 2: Rulează** `node scripts/tmp-movies-i18n.mjs && node scripts/i18n-guard.mjs` → „chei complete", apoi `rm scripts/tmp-movies-i18n.mjs`.

- [ ] **Step 3: Commit**
```bash
git add messages
git commit -m "feat(movies): traduceri pentru Movies în 7 locale"
```

---

### Task 9: Pagina cinematic `/movies`

**Files:**
- Create: `app/[locale]/movies/page.tsx`, `app/[locale]/movies/MoviesClient.tsx`, `components/movies/PosterCard.tsx`, `components/movies/HeroTrailer.tsx`
- Modify: `components/BottomNav.tsx:26` — adaugă `"/movies"` în `hiddenPaths`.

**Interfaces:**
- Consumes: `GET /api/movies` (Task 6): `{ items: SeriesDto[], continueWatching: {series, episodeNumber, positionMs, durationMs}[], nextPage }`; `useHlsVideo` din `lib/video/useHlsVideo`.
- Produces: `PosterCard({ series, progressPct?, href })`, `HeroTrailer({ series, playbackUrl })`.

- [ ] **Step 1: Pagina server**

```tsx
// app/[locale]/movies/page.tsx
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { isEnabled } from "@/lib/feature-flags";
import MoviesClient from "./MoviesClient";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "meta" });
  return { title: t("moviesTitle"), description: t("moviesDescription") };
}

export default function MoviesPage() {
  if (!isEnabled("movies")) notFound();
  return <MoviesClient />;
}
```

- [ ] **Step 2: Componente**

```tsx
// components/movies/PosterCard.tsx
"use client";
import Link from "next/link";
import Image from "next/image";
import type { SeriesDto } from "@/lib/movies/types";

export default function PosterCard({ series, href, progressPct, rank }: { series: SeriesDto; href: string; progressPct?: number; rank?: number }) {
  return (
    <Link href={href} className="group relative block w-[42vw] max-w-[180px] shrink-0 snap-start">
      <div className="relative aspect-[9/16] overflow-hidden rounded-2xl bg-neutral-900 ring-1 ring-white/10 transition-transform duration-300 group-active:scale-95 group-hover:scale-[1.03]">
        {series.posterUrl ? (
          <Image src={series.posterUrl} alt={series.title} fill sizes="42vw" className="object-cover" />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-b from-neutral-700 to-black" />
        )}
        <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/90 to-transparent" />
        {rank !== undefined && (
          <span className="absolute -left-1 bottom-2 text-[64px] font-black leading-none text-white/90 drop-shadow-[0_2px_12px_rgba(0,0,0,0.8)]" style={{ WebkitTextStroke: "2px rgba(255,255,255,0.35)" }}>{rank}</span>
        )}
        {series.isAdult && <span className="absolute right-2 top-2 rounded-md bg-red-600 px-1.5 py-0.5 text-[10px] font-black text-white">18+</span>}
        {progressPct !== undefined && (
          <div className="absolute inset-x-0 bottom-0 h-1 bg-white/20"><div className="h-full bg-red-500" style={{ width: `${Math.min(100, Math.max(2, progressPct))}%` }} /></div>
        )}
      </div>
      <p className="mt-2 line-clamp-2 text-[13px] font-bold leading-tight text-white">{series.title}</p>
    </Link>
  );
}
```

```tsx
// components/movies/HeroTrailer.tsx
"use client";
import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { Play, Volume2, VolumeX } from "lucide-react";
import { useTranslations } from "next-intl";
import { useHlsVideo } from "@/lib/video/useHlsVideo";
import type { SeriesDto } from "@/lib/movies/types";

/** Hero 100vh: trailerul (sau ep. 1) redat mut în loop, gradient spre negru, CTA. */
export default function HeroTrailer({ series, playbackUrl }: { series: SeriesDto; playbackUrl: string | null }) {
  const t = useTranslations("movies");
  const [muted, setMuted] = useState(true);
  const videoRef = useHlsVideo(playbackUrl);
  return (
    <section className="relative h-[92vh] w-full overflow-hidden bg-black">
      {playbackUrl ? (
        <video ref={videoRef} className="absolute inset-0 h-full w-full object-cover" autoPlay loop muted={muted} playsInline poster={series.coverUrl ?? series.posterUrl ?? undefined} />
      ) : series.coverUrl || series.posterUrl ? (
        <Image src={series.coverUrl ?? series.posterUrl!} alt="" fill priority sizes="100vw" className="object-cover" />
      ) : null}
      <div className="absolute inset-0 bg-gradient-to-t from-black via-black/40 to-black/20" />
      <div className="absolute inset-x-0 bottom-0 px-5 pb-10" style={{ paddingBottom: "max(40px, env(safe-area-inset-bottom))" }}>
        {series.owner.isOfficial && <span className="mb-2 inline-block rounded-md bg-white px-2 py-0.5 text-[10px] font-black uppercase tracking-widest text-black">{t("official")}</span>}
        <h1 className="text-4xl font-black leading-[0.95] tracking-tight text-white drop-shadow-lg sm:text-6xl">{series.title}</h1>
        <p className="mt-2 line-clamp-2 max-w-md text-sm text-white/80">{series.synopsis}</p>
        <p className="mt-1 text-xs font-semibold text-white/60">{t("episodes", { count: series.episodeCount })} · {t("freeEpisodesLabel", { n: series.freeEpisodes })}</p>
        <div className="mt-4 flex items-center gap-2">
          <Link href={`/movies/${series.slug}/1`} className="flex items-center gap-2 rounded-xl bg-white px-5 py-3 text-sm font-black text-black active:scale-95"><Play size={16} fill="currentColor" /> {t("watchNow")}</Link>
          <Link href={`/movies/${series.slug}`} className="rounded-xl bg-white/15 px-4 py-3 text-sm font-bold text-white backdrop-blur active:scale-95">{t("synopsis")}</Link>
          {playbackUrl && (
            <button type="button" onClick={() => setMuted((m) => !m)} aria-label={muted ? t("unmute") : t("mute")} className="ml-auto rounded-full bg-black/50 p-2.5 text-white ring-1 ring-white/20">{muted ? <VolumeX size={18} /> : <Volume2 size={18} />}</button>
          )}
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 3: Clientul catalogului**

```tsx
// app/[locale]/movies/MoviesClient.tsx
"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { useTranslations } from "next-intl";
import HeroTrailer from "@/components/movies/HeroTrailer";
import PosterCard from "@/components/movies/PosterCard";
import type { SeriesDto } from "@/lib/movies/types";

type Catalog = {
  items: SeriesDto[];
  continueWatching: Array<{ series: SeriesDto; episodeNumber: number; positionMs: number; durationMs: number | null }>;
  nextPage: number | null;
};

function Row({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-7">
      <h2 className="mb-3 px-5 text-base font-black uppercase tracking-wider text-white/90">{title}</h2>
      <div className="flex snap-x snap-mandatory gap-3 overflow-x-auto px-5 pb-2 [scrollbar-width:none]">{children}</div>
    </section>
  );
}

export default function MoviesClient() {
  const t = useTranslations("movies");
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [fresh, setFresh] = useState<SeriesDto[]>([]);
  const [heroUrl, setHeroUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch("/api/movies?sort=trending").then((r) => (r.ok ? r.json() : Promise.reject(r.status))),
      fetch("/api/movies?sort=new").then((r) => (r.ok ? r.json() : Promise.reject(r.status))),
    ])
      .then(([trending, latest]: [Catalog, Catalog]) => { setCatalog(trending); setFresh(latest.items); })
      .catch(() => setError(true));
  }, []);

  const featured = catalog?.items[0] ?? null;
  useEffect(() => {
    if (!featured) return;
    // Ep. 1 e gratuit ⇒ play întoarce URL-ul public direct; îl folosim ca trailer.
    fetch(`/api/movies/${featured.slug}/episodes/1/play`).then((r) => (r.ok ? r.json() : null)).then((d) => setHeroUrl(d?.playbackUrl ?? null)).catch(() => setHeroUrl(null));
  }, [featured]);

  if (error) return <div className="flex min-h-screen items-center justify-center bg-black text-white/70">{t("loadError")}</div>;

  return (
    <main className="min-h-screen bg-black pb-16 text-white">
      <Link href="/" aria-label={t("back")} className="fixed left-4 top-4 z-30 rounded-full bg-black/50 p-2.5 text-white backdrop-blur ring-1 ring-white/15" style={{ top: "max(16px, env(safe-area-inset-top))" }}><ArrowLeft size={20} /></Link>
      {featured ? <HeroTrailer series={featured} playbackUrl={heroUrl} /> : (
        <div className="flex h-[60vh] items-end px-5 pb-8"><h1 className="text-4xl font-black">{t("title")}</h1></div>
      )}
      {catalog && catalog.items.length === 0 && <p className="px-5 pt-6 text-white/60">{t("empty")}</p>}
      {catalog && catalog.continueWatching.length > 0 && (
        <Row title={t("continueWatching")}>
          {catalog.continueWatching.map((c) => (
            <PosterCard key={c.series.id} series={c.series} href={`/movies/${c.series.slug}/${c.episodeNumber}`} progressPct={c.durationMs ? Math.round((c.positionMs / c.durationMs) * 100) : 0} />
          ))}
        </Row>
      )}
      {catalog && catalog.items.length > 0 && (
        <Row title={t("trending")}>
          {catalog.items.slice(0, 10).map((s, i) => <PosterCard key={s.id} series={s} href={`/movies/${s.slug}`} rank={i + 1} />)}
        </Row>
      )}
      {fresh.length > 0 && (
        <Row title={t("newReleases")}>{fresh.map((s) => <PosterCard key={s.id} series={s} href={`/movies/${s.slug}`} />)}</Row>
      )}
    </main>
  );
}
```

În `components/BottomNav.tsx` linia 26, adaugă `"/movies"` la începutul array-ului `hiddenPaths`.

- [ ] **Step 4: Verifică vizual** `npx next dev` → `/movies` cu `FEATURE_MOVIES=1 NEXT_PUBLIC_FEATURE_MOVIES=1` în `.env.local`; fără flag → 404. Gate: `npx tsc --noEmit --incremental false`, `npx eslint "app/[locale]/movies" components/movies components/BottomNav.tsx`.

- [ ] **Step 5: Commit**
```bash
git add "app/[locale]/movies/page.tsx" "app/[locale]/movies/MoviesClient.tsx" components/movies/PosterCard.tsx components/movies/HeroTrailer.tsx components/BottomNav.tsx
git commit -m "feat(movies): pagina cinematic /movies (hero cu trailer, Top 10, noutăți, continuă să vezi)"
```

---

### Task 10: Pagina serialului `/movies/[slug]`

**Files:**
- Create: `app/[locale]/movies/[slug]/page.tsx`, `app/[locale]/movies/[slug]/SeriesClient.tsx`, `components/movies/UnlockButton.tsx`

**Interfaces:**
- Consumes: `GET /api/movies/[slug]` → `{ series: SeriesDto, episodes: EpisodeDto[], viewer: { balanceUnits, hasSeasonUnlock, isOwner } }`; `POST /api/movies/[slug]/unlock`.
- Produces: `UnlockButton({ slug, target: {episodeId}|{season:true}, priceUnits, balanceUnits, onUnlocked })` refolosit în player.

- [ ] **Step 1: UnlockButton**

```tsx
// components/movies/UnlockButton.tsx
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Lock, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { haptic } from "@/lib/haptic";
import { SWYP_UNITS_PER_COIN } from "@/lib/movies/config";

export function unitsToSwyp(units: number): string {
  return (units / SWYP_UNITS_PER_COIN).toLocaleString("ro-RO", { maximumFractionDigits: 2 });
}

type Props = {
  slug: string;
  target: { episodeId: string } | { season: true };
  priceUnits: number;
  balanceUnits: number | null;
  label: string;
  onUnlocked: (balanceUnits: number) => void;
};

export default function UnlockButton({ slug, target, priceUnits, balanceUnits, label, onUnlocked }: Props) {
  const t = useTranslations("movies");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const insufficient = balanceUnits !== null && balanceUnits < priceUnits;

  const unlock = async () => {
    haptic("tap");
    if (balanceUnits === null) { router.push(`/auth?next=/movies/${slug}`); return; }
    setBusy(true); setNotice(null);
    try {
      const res = await fetch(`/api/movies/${slug}/unlock`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(target) });
      const data = await res.json();
      if (res.ok) { setNotice(t("unlocked")); onUnlocked(Number(data.balanceUnits ?? 0)); return; }
      if (res.status === 401) { router.push(`/auth?next=/movies/${slug}`); return; }
      setNotice(data.error === "insufficient_balance" ? t("insufficient") : t("error"));
    } catch { setNotice(t("error")); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-2">
      <button type="button" onClick={unlock} disabled={busy || insufficient} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-white px-5 py-3.5 text-sm font-black text-black disabled:opacity-50 active:scale-95">
        {busy ? <Loader2 size={16} className="animate-spin" /> : <Lock size={16} />}
        {busy ? t("unlocking") : balanceUnits === null ? t("loginToUnlock") : `${label} · ${t("priceSwyp", { amount: unitsToSwyp(priceUnits) })}`}
      </button>
      {balanceUnits !== null && <p className="text-center text-[11px] text-white/60">{t("yourBalance", { amount: unitsToSwyp(balanceUnits) })}</p>}
      {(insufficient || notice) && <p className="text-center text-xs text-amber-300">{notice ?? t("insufficient")}</p>}
    </div>
  );
}
```

- [ ] **Step 2: Pagina + client**

```tsx
// app/[locale]/movies/[slug]/page.tsx
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isEnabled } from "@/lib/feature-flags";
import { getSeriesBySlug } from "@/lib/movies/repository";
import SeriesClient from "./SeriesClient";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const series = await getSeriesBySlug(slug).catch(() => null);
  if (!series || series.status !== "published") return {};
  return { title: `${series.title} — Swypik Movies`, description: series.synopsis.slice(0, 160), openGraph: { images: series.posterUrl ? [series.posterUrl] : [] } };
}

export default async function SeriesPage({ params }: { params: Promise<{ slug: string }> }) {
  if (!isEnabled("movies")) notFound();
  const { slug } = await params;
  return <SeriesClient slug={slug} />;
}
```

```tsx
// app/[locale]/movies/[slug]/SeriesClient.tsx
"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { ArrowLeft, Lock, Play } from "lucide-react";
import { useTranslations } from "next-intl";
import UnlockButton, { unitsToSwyp } from "@/components/movies/UnlockButton";
import { MOVIES_SEASON_DISCOUNT_PCT } from "@/lib/movies/config";
import type { EpisodeDto, SeriesDto } from "@/lib/movies/types";

type Payload = { series: SeriesDto; episodes: EpisodeDto[]; viewer: { balanceUnits: number | null; hasSeasonUnlock: boolean; isOwner: boolean } };

export default function SeriesClient({ slug }: { slug: string }) {
  const t = useTranslations("movies");
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(() => {
    fetch(`/api/movies/${slug}`).then((r) => (r.ok ? r.json() : Promise.reject(r.status))).then(setData).catch(() => setError(true));
  }, [slug]);
  useEffect(load, [load]);

  if (error) return <div className="flex min-h-screen items-center justify-center bg-black text-white/70">{t("loadError")}</div>;
  if (!data) return <div className="min-h-screen bg-black" />;

  const { series, episodes, viewer } = data;
  const inProgress = episodes.find((e) => e.progress && !e.progress.completed);
  const nextUnwatched = episodes.find((e) => !e.progress?.completed);
  const resume = inProgress ?? nextUnwatched ?? episodes[0];
  const lockedCount = episodes.filter((e) => e.locked).length;

  return (
    <main className="min-h-screen bg-black pb-24 text-white">
      <Link href="/movies" aria-label={t("back")} className="fixed left-4 z-30 rounded-full bg-black/50 p-2.5 backdrop-blur ring-1 ring-white/15" style={{ top: "max(16px, env(safe-area-inset-top))" }}><ArrowLeft size={20} /></Link>
      <section className="relative h-[70vh]">
        {series.posterUrl && <Image src={series.posterUrl} alt={series.title} fill priority sizes="100vw" className="object-cover" />}
        <div className="absolute inset-0 bg-gradient-to-t from-black via-black/50 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 px-5 pb-5">
          {series.owner.isOfficial ? <span className="rounded-md bg-white px-2 py-0.5 text-[10px] font-black uppercase tracking-widest text-black">{t("official")}</span> : <span className="text-xs text-white/70">{t("by", { name: series.owner.name })}</span>}
          <h1 className="mt-2 text-4xl font-black leading-[0.95] tracking-tight">{series.title}</h1>
          <p className="mt-2 text-xs font-semibold text-white/60">{series.genres.join(" · ")} · {t("episodes", { count: series.episodeCount })}{series.isAdult ? ` · ${t("adult")}` : ""}</p>
        </div>
      </section>

      <section className="space-y-3 px-5 pt-4">
        {resume && (
          <Link href={`/movies/${slug}/${resume.number}`} className="flex items-center justify-center gap-2 rounded-2xl bg-white px-5 py-3.5 text-sm font-black text-black active:scale-95">
            <Play size={16} fill="currentColor" /> {inProgress ? t("continueEpisode", { n: resume.number }) : t("startEpisode")}
          </Link>
        )}
        {lockedCount > 0 && !viewer.hasSeasonUnlock && !viewer.isOwner && series.seasonPriceUnits > 0 && (
          <div className="rounded-2xl bg-white/5 p-3 ring-1 ring-white/10">
            <UnlockButton slug={slug} target={{ season: true }} priceUnits={series.seasonPriceUnits} balanceUnits={viewer.balanceUnits} label={t("unlockSeason")} onUnlocked={load} />
            <p className="mt-1 text-center text-[11px] text-white/50">{t("seasonDiscount", { pct: MOVIES_SEASON_DISCOUNT_PCT })}</p>
          </div>
        )}
        <p className="text-sm leading-relaxed text-white/80">{series.synopsis}</p>
      </section>

      <section className="mt-6 px-5">
        <h2 className="mb-3 text-base font-black uppercase tracking-wider text-white/90">{t("episodes", { count: episodes.length })}</h2>
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
          {episodes.map((e) => (
            <Link key={e.id} href={`/movies/${slug}/${e.number}`} className={`relative flex aspect-square flex-col items-center justify-center rounded-xl text-sm font-black ring-1 ${e.locked ? "bg-neutral-900 text-white/50 ring-white/10" : "bg-white/10 text-white ring-white/20"} ${e.progress?.completed ? "opacity-60" : ""}`}>
              {e.number}
              {e.locked ? <Lock size={11} className="absolute right-1.5 top-1.5" /> : e.number <= series.freeEpisodes ? <span className="absolute inset-x-1 bottom-1 text-[9px] font-bold uppercase text-emerald-400">{t("free")}</span> : null}
              {e.locked && <span className="absolute inset-x-1 bottom-1 text-[9px] text-white/40">{unitsToSwyp(e.priceUnits)} SWYP</span>}
            </Link>
          ))}
        </div>
      </section>
    </main>
  );
}
```

- [ ] **Step 3: Gate + commit**

Run: `npx tsc --noEmit --incremental false`; `npx eslint "app/[locale]/movies/[slug]" components/movies/UnlockButton.tsx`.
```bash
git add "app/[locale]/movies/[slug]/page.tsx" "app/[locale]/movies/[slug]/SeriesClient.tsx" components/movies/UnlockButton.tsx
git commit -m "feat(movies): pagina serialului cu grila de episoade, deblocare sezon și reluare"
```

---

### Task 11: Player-ul `/movies/[slug]/[n]` cu paywall

**Files:**
- Create: `app/[locale]/movies/[slug]/[n]/page.tsx`, `app/[locale]/movies/[slug]/[n]/PlayerClient.tsx`, `components/movies/PaywallSlide.tsx`

**Interfaces:**
- Consumes: `GET /api/movies/[slug]` (lista episoadelor + starea viewer-ului), `GET /api/movies/[slug]/episodes/[n]/play` → 200 `{ videoId, playbackUrl, poster, expiresAt }` | 402 `{ error:"locked", priceUnits, seasonPriceUnits, balanceUnits, requireAuth }`; `POST /api/movies/progress`; `useHlsVideo`; `UnlockButton`.

- [ ] **Step 1: PaywallSlide**

```tsx
// components/movies/PaywallSlide.tsx
"use client";
import { Lock } from "lucide-react";
import { useTranslations } from "next-intl";
import UnlockButton from "./UnlockButton";

type Props = {
  slug: string; episodeId: string; episodeNumber: number; totalEpisodes: number;
  priceUnits: number; seasonPriceUnits: number; balanceUnits: number | null; poster: string | null;
  onUnlocked: () => void;
};

export default function PaywallSlide(p: Props) {
  const t = useTranslations("movies");
  return (
    <div className="relative flex h-full w-full flex-col items-center justify-end bg-neutral-950 px-6 pb-24 text-white">
      {p.poster && <div className="absolute inset-0 bg-cover bg-center opacity-30 blur-md" style={{ backgroundImage: `url(${p.poster})` }} />}
      <div className="relative w-full max-w-sm space-y-3 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-white/10 ring-1 ring-white/20"><Lock size={24} /></div>
        <p className="text-xs font-bold uppercase tracking-widest text-white/60">{t("episodeOf", { n: p.episodeNumber, total: p.totalEpisodes })}</p>
        <h2 className="text-2xl font-black">{t("locked")}</h2>
        <UnlockButton slug={p.slug} target={{ episodeId: p.episodeId }} priceUnits={p.priceUnits} balanceUnits={p.balanceUnits} label={t("unlockEpisode")} onUnlocked={p.onUnlocked} />
        {p.seasonPriceUnits > 0 && (
          <UnlockButton slug={p.slug} target={{ season: true }} priceUnits={p.seasonPriceUnits} balanceUnits={p.balanceUnits} label={t("unlockSeason")} onUnlocked={p.onUnlocked} />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Player**

```tsx
// app/[locale]/movies/[slug]/[n]/page.tsx
import { notFound } from "next/navigation";
import { isEnabled } from "@/lib/feature-flags";
import PlayerClient from "./PlayerClient";

export const dynamic = "force-dynamic";

export default async function PlayerPage({ params }: { params: Promise<{ slug: string; n: string }> }) {
  if (!isEnabled("movies")) notFound();
  const { slug, n } = await params;
  const episodeNumber = Number(n);
  if (!Number.isInteger(episodeNumber) || episodeNumber < 1) notFound();
  return <PlayerClient slug={slug} initialEpisode={episodeNumber} />;
}
```

```tsx
// app/[locale]/movies/[slug]/[n]/PlayerClient.tsx
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Volume2, VolumeX } from "lucide-react";
import { useTranslations } from "next-intl";
import { useHlsVideo } from "@/lib/video/useHlsVideo";
import PaywallSlide from "@/components/movies/PaywallSlide";
import type { EpisodeDto, SeriesDto } from "@/lib/movies/types";

type SeriesPayload = { series: SeriesDto; episodes: EpisodeDto[]; viewer: { balanceUnits: number | null } };
type PlayOk = { videoId: string; playbackUrl: string; poster: string | null };
type PlayLocked = { error: "locked"; priceUnits: number; seasonPriceUnits: number; balanceUnits: number | null; requireAuth: boolean };
type PlayState = { kind: "loading" } | { kind: "ok"; data: PlayOk } | { kind: "locked"; data: PlayLocked } | { kind: "error" };

const PROGRESS_INTERVAL_MS = 5000;

function EpisodeVideo({ src, poster, muted, onEnded, onTime, resumeMs }: { src: string; poster: string | null; muted: boolean; onEnded: () => void; onTime: (ms: number, durationMs: number) => void; resumeMs: number }) {
  const ref = useHlsVideo(src);
  useEffect(() => {
    const v = ref.current; if (!v) return;
    const seek = () => { if (resumeMs > 0 && v.currentTime < resumeMs / 1000) v.currentTime = resumeMs / 1000; };
    v.addEventListener("loadedmetadata", seek, { once: true });
    v.play().catch(() => undefined);
    return () => v.removeEventListener("loadedmetadata", seek);
  }, [ref, src, resumeMs]);
  return (
    <video ref={ref} className="h-full w-full object-cover" playsInline muted={muted} poster={poster ?? undefined}
      onEnded={onEnded} onTimeUpdate={(e) => onTime(e.currentTarget.currentTime * 1000, e.currentTarget.duration * 1000)} />
  );
}

export default function PlayerClient({ slug, initialEpisode }: { slug: string; initialEpisode: number }) {
  const t = useTranslations("movies");
  const [payload, setPayload] = useState<SeriesPayload | null>(null);
  const [current, setCurrent] = useState(initialEpisode);
  const [play, setPlay] = useState<PlayState>({ kind: "loading" });
  const [muted, setMuted] = useState(false);
  const lastSentRef = useRef(0);

  const loadSeries = useCallback(() => fetch(`/api/movies/${slug}`).then((r) => (r.ok ? r.json() : Promise.reject(r.status))).then(setPayload).catch(() => setPlay({ kind: "error" })), [slug]);
  useEffect(() => { void loadSeries(); }, [loadSeries]);

  const loadPlay = useCallback(async (n: number) => {
    setPlay({ kind: "loading" });
    const res = await fetch(`/api/movies/${slug}/episodes/${n}/play`).catch(() => null);
    if (!res) { setPlay({ kind: "error" }); return; }
    const data = await res.json();
    if (res.ok) setPlay({ kind: "ok", data });
    else if (res.status === 402) setPlay({ kind: "locked", data });
    else setPlay({ kind: "error" });
  }, [slug]);
  useEffect(() => { void loadPlay(current); window.history.replaceState(null, "", `/movies/${slug}/${current}`); }, [current, loadPlay, slug]);

  const episode = payload?.episodes.find((e) => e.number === current) ?? null;
  const total = payload?.episodes.length ?? 0;

  const sendProgress = useCallback((positionMs: number, completed: boolean) => {
    if (!episode || !payload?.viewer || payload.viewer.balanceUnits === null) return; // anonim: fără progres
    const body = JSON.stringify({ episodeId: episode.id, positionMs: Math.round(positionMs), completed });
    if (navigator.sendBeacon) navigator.sendBeacon("/api/movies/progress", new Blob([body], { type: "application/json" }));
    else void fetch("/api/movies/progress", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true });
  }, [episode, payload]);

  const onTime = useCallback((ms: number) => {
    const now = Date.now();
    if (now - lastSentRef.current > PROGRESS_INTERVAL_MS) { lastSentRef.current = now; sendProgress(ms, false); }
  }, [sendProgress]);

  const goNext = useCallback(() => {
    sendProgress(episode?.durationMs ?? 0, true);
    if (current < total) setCurrent((c) => c + 1);
  }, [current, total, episode, sendProgress]);

  // swipe vertical: sus = următorul, jos = anteriorul
  const touchStart = useRef<number | null>(null);
  const onTouchStart = (e: React.TouchEvent) => { touchStart.current = e.touches[0].clientY; };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (touchStart.current === null) return;
    const dy = e.changedTouches[0].clientY - touchStart.current; touchStart.current = null;
    if (dy < -80 && current < total) setCurrent((c) => c + 1);
    if (dy > 80 && current > 1) setCurrent((c) => c - 1);
  };

  return (
    <div className="fixed inset-0 bg-black text-white" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      {play.kind === "ok" && episode && (
        <EpisodeVideo src={play.data.playbackUrl} poster={play.data.poster} muted={muted} onEnded={goNext} onTime={onTime} resumeMs={episode.progress?.completed ? 0 : episode.progress?.positionMs ?? 0} />
      )}
      {play.kind === "locked" && episode && payload && (
        <PaywallSlide slug={slug} episodeId={episode.id} episodeNumber={current} totalEpisodes={total} priceUnits={play.data.priceUnits} seasonPriceUnits={play.data.seasonPriceUnits} balanceUnits={play.data.balanceUnits} poster={payload.series.posterUrl} onUnlocked={() => { void loadSeries(); void loadPlay(current); }} />
      )}
      {play.kind === "error" && <div className="flex h-full items-center justify-center text-white/70">{t("loadError")}</div>}

      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-center gap-3 px-4" style={{ paddingTop: "max(12px, env(safe-area-inset-top))" }}>
        <Link href={`/movies/${slug}`} aria-label={t("back")} className="pointer-events-auto rounded-full bg-black/50 p-2.5 backdrop-blur"><ArrowLeft size={20} /></Link>
        <div className="flex flex-1 gap-1">
          {payload?.episodes.slice(0, 40).map((e) => <span key={e.id} className={`h-0.5 flex-1 rounded ${e.number < current ? "bg-white" : e.number === current ? "bg-red-500" : "bg-white/25"}`} />)}
        </div>
        <button type="button" onClick={() => setMuted((m) => !m)} aria-label={muted ? t("unmute") : t("mute")} className="pointer-events-auto rounded-full bg-black/50 p-2.5 backdrop-blur">{muted ? <VolumeX size={18} /> : <Volume2 size={18} />}</button>
      </div>

      {payload && episode && play.kind === "ok" && (
        <div className="absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/80 to-transparent px-5 pb-8 pt-16" style={{ paddingBottom: "max(32px, env(safe-area-inset-bottom))" }}>
          <p className="text-[11px] font-bold uppercase tracking-widest text-white/60">{payload.series.title}</p>
          <h2 className="text-lg font-black">{t("episodeOf", { n: current, total })} · {episode.title}</h2>
          {current < total && <button type="button" onClick={goNext} className="mt-3 rounded-xl bg-white/15 px-4 py-2 text-xs font-bold backdrop-blur active:scale-95">{t("nextEpisode")} ↓</button>}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Verifică manual** ep. 1 gratuit redă; ep. `free_episodes+1` arată paywall-ul; după deblocare se reîncarcă și redă prin `/api/movies/stream/...`; swipe schimbă episodul; progresul apare în „Continuă să vezi". Gate: tsc + eslint pe fișierele noi.

- [ ] **Step 4: Commit**
```bash
git add "app/[locale]/movies/[slug]/[n]" components/movies/PaywallSlide.tsx
git commit -m "feat(movies): player vertical cu auto-next, progres și paywall SWYP"
```

---

### Task 12: Creator Studio `/creator/movies`

**Files:**
- Create: `app/creator/(dashboard)/movies/page.tsx`
- Modify: `app/creator/(dashboard)/layout.tsx:21-28` — adaugă `{ href: "/creator/movies", icon: "clapperboard", label: t("movies") }` după linia `/creator/videos`; cheia `movies` în namespace-ul folosit de layout (vezi `useTranslations(` din fișier) în cele 7 locale (valoare: „Movies").

**Interfaces:**
- Consumes: `GET/POST /api/creator/movies`, `GET/PATCH /api/creator/movies/[id]`, `POST /api/creator/movies/[id]/episodes`, `GET /api/creator/videos` (răspuns: `{ videos: [{ id, title, status, duration_ms, thumbnail_url }] }` — verifică forma exactă în `app/api/creator/videos/route.ts` și adaptează cheia listei).

- [ ] **Step 1: Pagina (client)**

```tsx
// app/creator/(dashboard)/movies/page.tsx
"use client";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Clapperboard, Plus } from "lucide-react";
import { unitsToSwyp } from "@/components/movies/UnlockButton";
import { MOVIES_DEFAULT_EPISODE_PRICE_UNITS, MOVIES_DEFAULT_FREE_EPISODES, MOVIES_MAX_FREE_EPISODES, SWYP_UNITS_PER_COIN } from "@/lib/movies/config";
import type { MovieEpisodeRow, MovieSeriesRow } from "@/lib/movies/types";

type Overview = { publisher: boolean; series: Array<MovieSeriesRow & { episode_count: number }>; earnings: { total_units: number; unlocks: number } };
type Video = { id: string; title: string | null; status: string; duration_ms: number | null };

const input = "w-full rounded-xl border border-[#E5E5E5] px-3 py-2 text-sm outline-none focus:border-[#0D0D0D]";

export default function CreatorMoviesPage() {
  const t = useTranslations("movies");
  const [data, setData] = useState<Overview | null>(null);
  const [selected, setSelected] = useState<{ series: MovieSeriesRow; episodes: MovieEpisodeRow[] } | null>(null);
  const [videos, setVideos] = useState<Video[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [form, setForm] = useState({ title: "", synopsis: "", genres: "", posterUrl: "", coverUrl: "", freeEpisodes: MOVIES_DEFAULT_FREE_EPISODES, priceSwyp: MOVIES_DEFAULT_EPISODE_PRICE_UNITS / SWYP_UNITS_PER_COIN, licenseNote: "", isAdult: false });
  const [episodeForm, setEpisodeForm] = useState({ videoId: "", title: "" });

  const load = useCallback(() => { fetch("/api/creator/movies").then((r) => r.json()).then(setData).catch(() => setMsg(t("error"))); }, [t]);
  useEffect(load, [load]);
  useEffect(() => { fetch("/api/creator/videos").then((r) => r.json()).then((d) => setVideos((d.videos ?? d.items ?? []).filter((v: Video) => v.status === "ready"))).catch(() => undefined); }, []);

  const openSeries = (id: string) => fetch(`/api/creator/movies/${id}`).then((r) => r.json()).then(setSelected);

  const createSeries = async (e: React.FormEvent) => {
    e.preventDefault(); setMsg(null);
    const res = await fetch("/api/creator/movies", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      title: form.title, synopsis: form.synopsis, genres: form.genres.split(",").map((g) => g.trim()).filter(Boolean),
      posterUrl: form.posterUrl || null, coverUrl: form.coverUrl || null, freeEpisodes: form.freeEpisodes,
      episodePriceUnits: Math.round(form.priceSwyp * SWYP_UNITS_PER_COIN), licenseNote: form.licenseNote || null, isAdult: form.isAdult,
    }) });
    setMsg(res.ok ? t("saved") : t("error")); if (res.ok) load();
  };

  const addEpisode = async (e: React.FormEvent) => {
    e.preventDefault(); if (!selected) return; setMsg(null);
    const res = await fetch(`/api/creator/movies/${selected.series.id}/episodes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(episodeForm) });
    setMsg(res.ok ? t("saved") : t("error")); if (res.ok) { setEpisodeForm({ videoId: "", title: "" }); void openSeries(selected.series.id); load(); }
  };

  const submitReview = async () => {
    if (!selected) return;
    const res = await fetch(`/api/creator/movies/${selected.series.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "pending_review" }) });
    setMsg(res.ok ? t("saved") : t("error")); if (res.ok) { void openSeries(selected.series.id); load(); }
  };

  if (!data) return <div className="p-6 text-sm text-neutral-500">…</div>;
  if (!data.publisher) return <div className="m-6 rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">{t("notPublisher")}</div>;

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <header><h1 className="flex items-center gap-2 text-xl font-black"><Clapperboard size={22} /> {t("studio")}</h1><p className="text-sm text-neutral-600">{t("studioIntro")}</p></header>
      <div className="rounded-2xl bg-[#0D0D0D] p-4 text-white"><p className="text-xs uppercase tracking-wider text-white/60">{t("earnings")}</p><p className="text-2xl font-black">{unitsToSwyp(data.earnings.total_units)} SWYP</p><p className="text-xs text-white/60">{t("earningsUnlocks", { count: data.earnings.unlocks })}</p></div>
      {msg && <p className="text-sm font-semibold text-emerald-700">{msg}</p>}

      <section className="grid gap-3 sm:grid-cols-2">
        {data.series.map((s) => (
          <button key={s.id} type="button" onClick={() => openSeries(s.id)} className="rounded-2xl border border-[#E5E5E5] p-4 text-left hover:border-[#0D0D0D]">
            <p className="font-bold">{s.title}</p>
            <p className="text-xs text-neutral-500">{t(`status${s.status === "pending_review" ? "PendingReview" : s.status[0].toUpperCase() + s.status.slice(1)}` as "statusDraft")} · {t("episodes", { count: s.episode_count })}</p>
          </button>
        ))}
      </section>

      {selected && (
        <section className="space-y-3 rounded-2xl border border-[#E5E5E5] p-4">
          <h2 className="font-black">{selected.series.title}</h2>
          <ol className="space-y-1 text-sm">{selected.episodes.map((e) => <li key={e.id}>{t("episode", { n: e.episode_number })} — {e.title}</li>)}</ol>
          <form onSubmit={addEpisode} className="grid gap-2 sm:grid-cols-3">
            <select required value={episodeForm.videoId} onChange={(e) => setEpisodeForm({ ...episodeForm, videoId: e.target.value })} className={input}><option value="">{t("pickVideo")}</option>{videos.map((v) => <option key={v.id} value={v.id}>{v.title ?? v.id.slice(0, 8)}</option>)}</select>
            <input required value={episodeForm.title} onChange={(e) => setEpisodeForm({ ...episodeForm, title: e.target.value })} placeholder={t("episodeTitle")} className={input} />
            <button type="submit" className="rounded-xl bg-[#0D0D0D] px-4 py-2 text-sm font-bold text-white"><Plus size={14} className="inline" /> {t("addEpisode")}</button>
          </form>
          {selected.series.status === "draft" && <button type="button" onClick={submitReview} className="rounded-xl border border-[#0D0D0D] px-4 py-2 text-sm font-bold">{t("submitReview")}</button>}
        </section>
      )}

      <form onSubmit={createSeries} className="space-y-2 rounded-2xl border border-[#E5E5E5] p-4">
        <h2 className="font-black">{t("newSeries")}</h2>
        <input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder={t("seriesTitle")} className={input} />
        <textarea value={form.synopsis} onChange={(e) => setForm({ ...form, synopsis: e.target.value })} placeholder={t("seriesSynopsis")} rows={3} className={input} />
        <input value={form.genres} onChange={(e) => setForm({ ...form, genres: e.target.value })} placeholder={t("seriesGenres")} className={input} />
        <input value={form.posterUrl} onChange={(e) => setForm({ ...form, posterUrl: e.target.value })} placeholder={t("posterUrl")} className={input} />
        <input value={form.coverUrl} onChange={(e) => setForm({ ...form, coverUrl: e.target.value })} placeholder={t("coverUrl")} className={input} />
        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs">{t("freeEpisodesField")}<input type="number" min={0} max={MOVIES_MAX_FREE_EPISODES} value={form.freeEpisodes} onChange={(e) => setForm({ ...form, freeEpisodes: Number(e.target.value) })} className={input} /></label>
          <label className="text-xs">{t("episodePrice")}<input type="number" min={1} step={0.5} value={form.priceSwyp} onChange={(e) => setForm({ ...form, priceSwyp: Number(e.target.value) })} className={input} /></label>
        </div>
        <textarea value={form.licenseNote} onChange={(e) => setForm({ ...form, licenseNote: e.target.value })} placeholder={t("licenseNote")} rows={2} className={input} />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.isAdult} onChange={(e) => setForm({ ...form, isAdult: e.target.checked })} /> {t("isAdultField")}</label>
        <button type="submit" className="rounded-xl bg-[#0D0D0D] px-4 py-2 text-sm font-bold text-white">{t("create")}</button>
      </form>
    </div>
  );
}
```

- [ ] **Step 2: Nav + cheie i18n** — în `app/creator/(dashboard)/layout.tsx` adaugă item-ul; adaugă cheia `movies: "Movies"` (aceeași valoare în toate limbile) în namespace-ul layout-ului din cele 7 fișiere.

- [ ] **Step 3: Gate + commit** (`tsc`, `eslint`, `node scripts/i18n-guard.mjs`).
```bash
git add "app/creator/(dashboard)/movies/page.tsx" "app/creator/(dashboard)/layout.tsx" messages
git commit -m "feat(movies): Creator Studio — seriale, episoade, trimitere la review, câștiguri SWYP"
```

---

### Task 13: Admin `/admin/movies`

**Files:**
- Create: `app/admin/movies/page.tsx`
- Modify: `app/admin/AdminShell.tsx:103` — adaugă `{ href: "/admin/movies", label: "Movies", icon: Film }` după `Videos` (import `Film` din `lucide-react` alături de `Video`).

**Interfaces:**
- Consumes: `GET /api/admin/movies?status=`, `GET/PATCH /api/admin/movies/[id]`, `GET/POST/DELETE /api/admin/movies/publishers`.

- [ ] **Step 1: Pagina (client, `credentials: "same-origin"` ca `app/admin/videos/page.tsx`)**

```tsx
// app/admin/movies/page.tsx
"use client";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import type { MovieSeriesRow, SeriesStatus } from "@/lib/movies/types";

type Row = MovieSeriesRow & { episode_count: number; owner_name: string | null };
type Publisher = { user_id: string; display_name: string | null; username: string | null; email: string | null; note: string | null };
const STATUSES: SeriesStatus[] = ["pending_review", "draft", "published", "archived"];

export default function AdminMoviesPage() {
  const t = useTranslations("movies");
  const [status, setStatus] = useState<SeriesStatus>("pending_review");
  const [rows, setRows] = useState<Row[]>([]);
  const [publishers, setPublishers] = useState<Publisher[]>([]);
  const [newPublisher, setNewPublisher] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const opts: RequestInit = { credentials: "same-origin", headers: { "Content-Type": "application/json" } };

  const load = useCallback(() => {
    fetch(`/api/admin/movies?status=${status}`, opts).then((r) => r.json()).then((d) => setRows(d.series ?? [])).catch(() => setMsg(t("error")));
    fetch("/api/admin/movies/publishers", opts).then((r) => r.json()).then((d) => setPublishers(d.publishers ?? [])).catch(() => undefined);
  }, [status, t]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(load, [load]);

  const patch = async (id: string, body: Record<string, unknown>) => {
    const res = await fetch(`/api/admin/movies/${id}`, { ...opts, method: "PATCH", body: JSON.stringify(body) });
    const d = await res.json().catch(() => ({}));
    setMsg(res.ok ? t("saved") : `${t("error")} ${d.error ?? ""}`); load();
  };
  const approve = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await fetch("/api/admin/movies/publishers", { ...opts, method: "POST", body: JSON.stringify({ userId: newPublisher.trim() }) });
    setMsg(res.ok ? t("saved") : t("error")); if (res.ok) { setNewPublisher(""); load(); }
  };

  return (
    <div className="space-y-6 p-6">
      <h1 className="text-xl font-black">{t("adminTitle")}</h1>
      {msg && <p className="text-sm font-semibold">{msg}</p>}
      <div className="flex gap-2">{STATUSES.map((s) => <button key={s} type="button" onClick={() => setStatus(s)} className={`rounded-full px-3 py-1 text-xs font-bold ${status === s ? "bg-black text-white" : "bg-neutral-100"}`}>{s}</button>)}</div>
      <table className="w-full text-sm">
        <thead><tr className="text-left text-xs uppercase text-neutral-500"><th>Serial</th><th>Owner</th><th>Ep.</th><th>Free</th><th>Preț</th><th></th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.id} className="border-t">
            <td className="py-2 font-bold">{r.title}<div className="text-xs font-normal text-neutral-500">{r.slug}{r.license_note ? "" : " · fără licență"}</div></td>
            <td>{r.owner_name ?? r.owner_user_id.slice(0, 8)}</td><td>{r.episode_count}</td><td>{r.free_episodes}</td><td>{r.episode_price_units}</td>
            <td className="space-x-1 text-right">
              {r.status !== "published" && <button type="button" onClick={() => patch(r.id, { status: "published" })} className="rounded-lg bg-emerald-600 px-2 py-1 text-xs font-bold text-white">{t("publish")}</button>}
              {r.status === "published" && <button type="button" onClick={() => patch(r.id, { status: "archived" })} className="rounded-lg bg-neutral-800 px-2 py-1 text-xs font-bold text-white">{t("archive")}</button>}
              {r.status !== "draft" && <button type="button" onClick={() => patch(r.id, { status: "draft" })} className="rounded-lg border px-2 py-1 text-xs font-bold">{t("backToDraft")}</button>}
            </td>
          </tr>
        ))}</tbody>
      </table>
      <section className="rounded-2xl border p-4">
        <h2 className="mb-2 font-black">{t("publishers")}</h2>
        <ul className="mb-3 space-y-1 text-sm">{publishers.map((p) => <li key={p.user_id}>{p.display_name ?? p.username ?? p.email} <span className="text-xs text-neutral-500">{p.user_id}</span></li>)}</ul>
        <form onSubmit={approve} className="flex gap-2"><input value={newPublisher} onChange={(e) => setNewPublisher(e.target.value)} placeholder={t("approvePublisher")} className="flex-1 rounded-xl border px-3 py-2 text-sm" /><button type="submit" className="rounded-xl bg-black px-4 py-2 text-sm font-bold text-white">OK</button></form>
      </section>
    </div>
  );
}
```

- [ ] **Step 2: Nav în AdminShell**, apoi gate (`tsc`, `eslint app/admin/movies app/admin/AdminShell.tsx`).

- [ ] **Step 3: Commit**
```bash
git add app/admin/movies/page.tsx app/admin/AdminShell.tsx
git commit -m "feat(movies): admin — review/publicare seriale și aprobare publisheri"
```

---

### Task 14: Hamburger, feed și insigna de episod

**Files:**
- Modify: `components/home/CategorySidebar.tsx` — în `SUPERAPP_MODULES`, imediat după blocul `squadBuy`, adaugă modulul Movies (import `Clapperboard` din `lucide-react`).
- Modify: `app/api/explore/feed/route.ts` — tipul `ExploreFeedRow` (linia 392), SELECT (după `cm.id AS mission_id`), JOIN-uri (după `LEFT JOIN users u ON v.creator_id = u.id`, linia 735), WHERE (linia 812) și maparea (înainte de `mission: row.mission_id ? {`, linia 940).
- Create: `components/movies/MovieEpisodeBadge.tsx`
- Modify: `app/[locale]/explore/ExploreClient.tsx` — în slide (după blocul `{nearActive ? (...) : (...)}` din jurul liniei 830), randează insigna când `video.movie` există.

**Interfaces:**
- Feed item primește `movie: { slug: string; title: string; episode: number; episodeCount: number } | null`.

- [ ] **Step 1: Hamburger**

```tsx
    ...(isEnabledClient("movies") ? [{
        id: "movies",
        brand: "Swypik Movies",
        label: "Seriale scurte verticale",
        badge: "Nou",
        badgeColor: "bg-red-600 text-white",
        accent: "#DC2626",
        Icon: Clapperboard,
        href: "/movies",
    }] : []),
```
(`label` rămâne românesc ca restul modulelor din acest fișier — sunt în baseline-ul scanner-ului; nu adăuga altele.)

- [ ] **Step 2: Feed API** — în `ExploreFeedRow` adaugă:
```ts
  movie_slug: string | null;
  movie_title: string | null;
  movie_episode_number: number | null;
  movie_episode_count: number | null;
```
În SELECT, după `cm.id AS mission_id,` (păstrează restul coloanelor `cm.*` existente):
```sql
        ms.slug        AS movie_slug,
        ms.title       AS movie_title,
        me.episode_number AS movie_episode_number,
        (SELECT COUNT(*)::int FROM movie_episodes me2 WHERE me2.series_id = ms.id AND me2.status = 'published') AS movie_episode_count,
```
După `LEFT JOIN users u ON v.creator_id = u.id`:
```sql
      LEFT JOIN movie_episodes me ON me.video_id = v.id
      LEFT JOIN movie_series   ms ON ms.id = me.series_id
```
În WHERE, după `AND v.effective_label = 'safe'`:
```sql
        AND (me.id IS NULL OR (ms.status = 'published' AND me.status = 'published' AND me.episode_number <= ms.free_episodes))
```
În mapare, înainte de `mission:`:
```ts
          movie: row.movie_slug ? { slug: row.movie_slug, title: row.movie_title ?? "", episode: row.movie_episode_number ?? 1, episodeCount: row.movie_episode_count ?? 0 } : null,
```

- [ ] **Step 3: Insigna**

```tsx
// components/movies/MovieEpisodeBadge.tsx
"use client";
import Link from "next/link";
import { Clapperboard, ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";

export default function MovieEpisodeBadge({ movie }: { movie: { slug: string; title: string; episode: number; episodeCount: number } }) {
  const t = useTranslations("movies");
  return (
    <Link href={`/movies/${movie.slug}/${movie.episode}`} className="pointer-events-auto absolute left-4 z-20 flex items-center gap-2 rounded-2xl bg-black/60 px-3 py-2 text-white backdrop-blur ring-1 ring-white/15 active:scale-95" style={{ top: "max(64px, calc(52px + env(safe-area-inset-top)))" }}>
      <Clapperboard size={16} className="text-red-400" />
      <span className="text-[11px] font-black leading-tight">{t("title")}<br /><span className="font-semibold text-white/70">{movie.title} · {t("episodeOf", { n: movie.episode, total: movie.episodeCount })}</span></span>
      <ChevronRight size={14} />
    </Link>
  );
}
```
În `ExploreClient.tsx`, imediat după ternarul `nearActive` din interiorul `<div className="video-slide">`:
```tsx
                {video.movie ? <MovieEpisodeBadge movie={video.movie} /> : null}
```
cu `import MovieEpisodeBadge from "@/components/movies/MovieEpisodeBadge";` la importuri.

- [ ] **Step 4: Gate + commit** (`tsc`, `eslint` pe cele 4 fișiere, `node scripts/i18n-guard.mjs`).
```bash
git add components/home/CategorySidebar.tsx app/api/explore/feed/route.ts components/movies/MovieEpisodeBadge.tsx "app/[locale]/explore/ExploreClient.tsx"
git commit -m "feat(movies): intrare în hamburger, episoadele gratuite în feed cu insignă și CTA"
```

---

### Task 15: Gate final, build și documentație

**Files:**
- Modify: `CLAUDE.md` (secțiunea Feature Flags: rând `FEATURE_MOVIES | OFF | Swypik Movies`; secțiunea Structura: `app/[locale]/movies/`, `lib/movies/`).
- Modify: `db/migrations/README.md` — nimic de schimbat; migrarea se aplică cu `scripts/db/apply-migration.sh db/migrations/20260921_0003_movies.sql`.

- [ ] **Step 1: Toate gate-urile**
```bash
npx tsc --noEmit --incremental false
npx vitest run
npx next lint
npx next build
node scripts/i18n-guard.mjs
```
Așteptat: 0 erori tsc, toate testele PASS (inclusiv `movies-*`), 0 erori lint, build OK, i18n-guard verde.

- [ ] **Step 2: Fum manual cu flag-ul pornit** (`.env.local`: `FEATURE_MOVIES=1`, `NEXT_PUBLIC_FEATURE_MOVIES=1`): aprobă un publisher din `/admin/movies` (ID-ul contului oficial), creează un serial din `/creator/movies` cu 4 episoade din clipuri `ready`, publică din admin, verifică `/movies`, ep. 1–3 redau, ep. 4 paywall, deblocare cu SWYP, insigna în `/explore` doar pentru ep. 1–3.

- [ ] **Step 3: Commit**
```bash
git add CLAUDE.md
git commit -m "docs(movies): flag și structură în CLAUDE.md"
```

## Ce rămâne pentru fazele următoare (în afara acestui plan)
Notificări „episod nou", „Lista mea", trailer dedicat per serial, cron de reconciliere a cotelor, Movies Pass (Stripe), gating 18+ pe verificarea de vârstă (MVP: `is_adult` vizibil doar adminului în catalog), descărcare offline, recomandări.
