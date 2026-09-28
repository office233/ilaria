-- Caching YouTube Music pentru conservarea cotei zilnice de 10.000 unități.
-- Un search YouTube consumă 100 de unități. Cu caching în DB (7 zile),
-- căutările frecvente consumă 0 unități și răspund sub 5ms.

CREATE TABLE IF NOT EXISTS youtube_music_cache (
    query       text PRIMARY KEY,
    tracks      jsonb NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL DEFAULT (now() + interval '7 days')
);

CREATE INDEX IF NOT EXISTS idx_youtube_music_cache_expires ON youtube_music_cache (expires_at);

CREATE TABLE IF NOT EXISTS youtube_tracks (
    video_id    text PRIMARY KEY,
    title       text NOT NULL,
    channel     text NOT NULL,
    cover_url   text,
    duration_ms integer NOT NULL DEFAULT 0,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_youtube_tracks_created ON youtube_tracks (created_at DESC);
