-- Migration: „Lista mea" pentru Swypik Movies.
CREATE TABLE IF NOT EXISTS movie_watchlist (
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    series_id  uuid NOT NULL REFERENCES movie_series(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, series_id)
);
CREATE INDEX IF NOT EXISTS idx_movie_watchlist_user_created ON movie_watchlist (user_id, created_at DESC);
