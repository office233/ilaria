-- Audio tracks library (Jamendo + future sources)
-- Sync via scripts/sync-jamendo.mjs (top tracks by popularity, downloaded to R2)

CREATE TABLE IF NOT EXISTS audio_tracks (
  id              BIGSERIAL PRIMARY KEY,
  source          TEXT NOT NULL DEFAULT 'jamendo',
  source_id       TEXT NOT NULL,
  title           TEXT NOT NULL,
  artist          TEXT NOT NULL,
  duration_s      INTEGER NOT NULL CHECK (duration_s > 0),
  audio_url       TEXT NOT NULL,
  preview_url     TEXT,
  image_url       TEXT,
  waveform_url    TEXT,
  tags            TEXT[] DEFAULT '{}',
  genre           TEXT,
  license         TEXT,
  attribution_url TEXT,
  popularity      INTEGER NOT NULL DEFAULT 0,
  plays_count     INTEGER NOT NULL DEFAULT 0,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(source, source_id)
);

CREATE INDEX IF NOT EXISTS idx_audio_tracks_popularity
  ON audio_tracks(popularity DESC) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_audio_tracks_genre ON audio_tracks(genre) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_audio_tracks_tags ON audio_tracks USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_audio_tracks_title_trgm
  ON audio_tracks USING GIN(title gin_trgm_ops);

-- Reels reference an audio track (optional)
ALTER TABLE videos ADD COLUMN IF NOT EXISTS audio_track_id BIGINT
  REFERENCES audio_tracks(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_videos_audio_track_id ON videos(audio_track_id)
  WHERE audio_track_id IS NOT NULL;
