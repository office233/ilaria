-- Migration: garda de vizibilitate Movies ține cont și de expirarea licenței.
--
-- Versiunea din 20260921_0004 forța 'private' doar pentru episoadele blocate.
-- Un titlu cu licența expirată nu mai are voie să apară nicăieri, deci nici
-- episoadele lui gratuite nu pot redeveni 'public' (aprobare la moderare,
-- toggle creator, cron publish-scheduled). Aceeași regulă ca
-- lib/movies/visibility.ts (targetVisibility + isSeriesPublic).
-- Doar CREATE OR REPLACE pe funcție; trigger-ul existent o folosește deja.

CREATE OR REPLACE FUNCTION movies_guard_video_visibility() RETURNS trigger AS $$
BEGIN
    IF NEW.visibility = 'public' AND EXISTS (
        SELECT 1
          FROM movie_episodes me
          JOIN movie_series ms ON ms.id = me.series_id
         WHERE me.video_id = NEW.id
           AND (ms.status <> 'published'
                OR me.status <> 'published'
                OR me.episode_number > ms.free_episodes
                OR (ms.license_expires_at IS NOT NULL AND ms.license_expires_at <= now()))
    ) THEN
        NEW.visibility := 'private';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
