-- Migration: garda de vizibilitate pentru episoadele Movies blocate.
--
-- `videos.visibility` are trei scriitori care pot pune 'public' fără să știe
-- de Movies: aprobarea la moderare (/api/internal/moderation/decide), toggle-ul
-- creatorului („Fă public") și cron-ul publish-scheduled. Un episod plătit
-- devenit 'public' ar fi servit gratis de /video/[id], căutare, profil.
--
-- Trigger-ul rulează ÎNAINTE de orice INSERT/UPDATE pe visibility și forțează
-- 'private' când videoclipul este un episod blocat (serial sau episod
-- nepublicat, ori episode_number > free_episodes). Aceeași regulă ca
-- lib/movies/visibility.ts (targetVisibility), aplicată la nivelul DB ca să
-- acopere și scriitorii viitori.

CREATE OR REPLACE FUNCTION movies_guard_video_visibility() RETURNS trigger AS $$
BEGIN
    IF NEW.visibility = 'public' AND EXISTS (
        SELECT 1
          FROM movie_episodes me
          JOIN movie_series ms ON ms.id = me.series_id
         WHERE me.video_id = NEW.id
           AND (ms.status <> 'published' OR me.status <> 'published' OR me.episode_number > ms.free_episodes)
    ) THEN
        NEW.visibility := 'private';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_movies_guard_video_visibility ON videos;
CREATE TRIGGER trg_movies_guard_video_visibility
    BEFORE INSERT OR UPDATE OF visibility ON videos
    FOR EACH ROW EXECUTE FUNCTION movies_guard_video_visibility();
