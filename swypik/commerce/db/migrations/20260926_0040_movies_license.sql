-- Migration: Swypik Movies — metadate de licență obligatorii înainte de publicare.
--
-- Fiecare titlu (serial sau film) poartă tipul licenței, textul de atribuire,
-- sursa, teritoriile și expirarea. Publicarea fără licență validă e refuzată
-- și de aplicație (lib/movies/license.ts) și aici, printr-un trigger care
-- rulează doar la tranziția spre 'published' (rândurile existente nu sunt
-- atinse). Aditivă și idempotentă: fără DROP pe date, fără conversii.

ALTER TABLE movie_series
    ADD COLUMN IF NOT EXISTS format text NOT NULL DEFAULT 'series'
        CHECK (format IN ('series', 'film')),
    ADD COLUMN IF NOT EXISTS license_type text
        CHECK (license_type IS NULL OR license_type IN ('cc_by', 'cc_by_sa', 'public_domain', 'owned', 'distributor')),
    ADD COLUMN IF NOT EXISTS attribution_text text,
    ADD COLUMN IF NOT EXISTS license_source_url text,
    ADD COLUMN IF NOT EXISTS license_territories text[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS license_expires_at timestamptz,
    ADD COLUMN IF NOT EXISTS license_recorded_by uuid REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS license_recorded_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_movie_series_license_expiry
    ON movie_series (license_expires_at) WHERE license_expires_at IS NOT NULL;

CREATE OR REPLACE FUNCTION movies_guard_license_on_publish() RETURNS trigger AS $$
BEGIN
    IF NEW.status = 'published' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'published') THEN
        IF NEW.license_type IS NULL THEN
            RAISE EXCEPTION 'movie_license_required' USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.license_type IN ('cc_by', 'cc_by_sa', 'distributor') AND COALESCE(btrim(NEW.attribution_text), '') = '' THEN
            RAISE EXCEPTION 'movie_attribution_required' USING ERRCODE = 'check_violation';
        END IF;
        IF cardinality(NEW.license_territories) = 0 THEN
            RAISE EXCEPTION 'movie_territory_required' USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.license_expires_at IS NOT NULL AND NEW.license_expires_at <= now() THEN
            RAISE EXCEPTION 'movie_license_expired' USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_movies_guard_license_on_publish ON movie_series;
CREATE TRIGGER trg_movies_guard_license_on_publish
    BEFORE INSERT OR UPDATE OF status ON movie_series
    FOR EACH ROW EXECUTE FUNCTION movies_guard_license_on_publish();
