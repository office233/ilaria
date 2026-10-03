-- Ensure unsafe or failed videos cannot remain visible on public Swypik surfaces.

BEGIN;

CREATE OR REPLACE FUNCTION public.enforce_video_public_safety()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'failed' AND NEW.visibility = 'public' THEN
    NEW.visibility := 'private';
    NEW.is_hidden := true;
  END IF;

  IF NEW.status = 'ready'
     AND NEW.visibility = 'public'
     AND COALESCE(NEW.effective_label, 'safe') IN ('adult', 'blocked') THEN
    NEW.visibility := 'private';
    NEW.is_hidden := true;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_video_public_safety ON public.videos;
CREATE TRIGGER trg_enforce_video_public_safety
  BEFORE INSERT OR UPDATE OF status, visibility, is_hidden, effective_label
  ON public.videos
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_video_public_safety();

WITH hidden_unsafe AS (
  UPDATE public.videos
     SET visibility = 'private',
         is_hidden = true,
         updated_at = NOW()
   WHERE status = 'ready'
     AND visibility = 'public'
     AND COALESCE(effective_label, 'safe') IN ('adult', 'blocked')
  RETURNING id
), hidden_failed AS (
  UPDATE public.videos
     SET visibility = 'private',
         is_hidden = true,
         updated_at = NOW()
   WHERE status = 'failed'
     AND visibility = 'public'
  RETURNING id
)
SELECT
  (SELECT COUNT(*) FROM hidden_unsafe) AS hidden_unsafe_videos,
  (SELECT COUNT(*) FROM hidden_failed) AS hidden_failed_videos;

COMMIT;
