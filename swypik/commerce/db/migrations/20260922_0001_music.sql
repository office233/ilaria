-- Swypik Music: artiști aprobați, albume, piese, deblocări, tips, contoare de plays, playlist-uri.
-- Idempotentă (IF NOT EXISTS). Spec: docs/superpowers/specs/2026-09-21-swypik-music-design.md

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
CREATE INDEX IF NOT EXISTS idx_music_tracks_album ON music_tracks (album_id) WHERE album_id IS NOT NULL;

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
CREATE INDEX IF NOT EXISTS idx_music_playlists_user ON music_playlists (user_id);

CREATE TABLE IF NOT EXISTS music_playlist_items (
    playlist_id uuid NOT NULL REFERENCES music_playlists(id) ON DELETE CASCADE,
    track_id    uuid NOT NULL REFERENCES music_tracks(id) ON DELETE CASCADE,
    position    integer NOT NULL DEFAULT 0,
    added_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (playlist_id, track_id)
);
