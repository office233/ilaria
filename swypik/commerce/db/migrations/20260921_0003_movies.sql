-- Migration: Swypik Movies — micro-seriale verticale.
--
-- Fiecare episod referă un rând `videos` (transcodare, moderare, captions,
-- like/comment rămân neschimbate). Structura serial/episod/preț/deblocare stă
-- în tabele proprii, tipizate. Idempotentă (IF NOT EXISTS).

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
