-- 20260926_0012_video_moderation_gate
--
-- Rezultatul moderării decide vizibilitatea în feed. Toate suprafețele publice
-- (feed explore/v1/universal, căutare, profil, sitemap, pagina /video) filtrează
-- deja `videos.effective_label = 'safe'`, așa că poarta e pusă pe această
-- coloană, într-un singur loc (DB), nu în zeci de query-uri:
--
--   moderation_status = 'pending_review' → effective_label = 'pending'
--   moderation_status = 'rejected'       → effective_label = 'rejected'
--   moderation_status = 'approved'       → eticheta clasificatorului
--                                          (adult/blocked rămân; restul = 'safe')
--
-- `visibility` rămâne intenția creatorului (public/draft/programat): aprobarea
-- NU mai publică draft-uri, iar respingerea ascunde clipul fără să-i piardă
-- setările. Clasificatorul (video_safety_labels) are acum efect în feed:
-- o etichetă reală adult/blocked (nu placeholder-ul 'auto_pending') se
-- sincronizează în videos.effective_label; trigger-ul existent
-- trg_enforce_video_public_safety face restul.
--
-- Backfill: clipurile pending_review/rejected dispar din feed până la
-- aprobare (coada: /api/internal/moderation/pending). Previzualizare:
--   SELECT moderation_status, count(*) FROM videos
--    WHERE visibility='public' AND status='ready' GROUP BY 1;
-- Idempotent; nimic nu se șterge.

BEGIN;

CREATE OR REPLACE FUNCTION public.video_feed_label(p_moderation text, p_safety text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_moderation = 'pending_review' THEN 'pending'
    WHEN p_moderation = 'rejected' THEN 'rejected'
    WHEN p_safety IN ('adult', 'blocked') THEN p_safety
    ELSE 'safe'
  END;
$$;

-- Eticheta reală a clasificatorului / override-ul uman (fără placeholder).
CREATE OR REPLACE FUNCTION public.video_classified_label(p_video_id uuid)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(human_override_label, label)
    FROM video_safety_labels
   WHERE video_id = p_video_id
     AND (reviewed_by_human OR classifier_version <> 'auto_pending')
   LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.video_moderation_label_gate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.moderation_status IN ('pending_review', 'rejected') THEN
    NEW.effective_label := public.video_feed_label(NEW.moderation_status, NULL);
  ELSIF COALESCE(NEW.effective_label, 'safe') IN ('pending', 'rejected') THEN
    NEW.effective_label := public.video_feed_label(
      NEW.moderation_status,
      public.video_classified_label(NEW.id)
    );
  END IF;
  RETURN NEW;
END;
$$;

-- Numele începe cu „trg_a_” ca să ruleze ÎNAINTEA trg_enforce_video_public_safety
-- (triggerele BEFORE rulează în ordine alfabetică).
DROP TRIGGER IF EXISTS trg_a_video_moderation_label ON public.videos;
CREATE TRIGGER trg_a_video_moderation_label
  BEFORE INSERT OR UPDATE OF moderation_status, effective_label
  ON public.videos
  FOR EACH ROW
  EXECUTE FUNCTION public.video_moderation_label_gate();

CREATE OR REPLACE FUNCTION public.video_safety_label_sync()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_label text;
BEGIN
  IF NOT NEW.reviewed_by_human AND NEW.classifier_version = 'auto_pending' THEN
    RETURN NEW;
  END IF;
  v_label := public.video_feed_label('approved', COALESCE(NEW.human_override_label, NEW.label));
  UPDATE public.videos
     SET effective_label = v_label,
         updated_at = NOW()
   WHERE id = NEW.video_id
     AND moderation_status = 'approved'
     AND effective_label IS DISTINCT FROM v_label;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_video_safety_label_sync ON public.video_safety_labels;
CREATE TRIGGER trg_video_safety_label_sync
  AFTER INSERT OR UPDATE OF label, human_override_label, reviewed_by_human, classifier_version
  ON public.video_safety_labels
  FOR EACH ROW
  EXECUTE FUNCTION public.video_safety_label_sync();

-- Backfill 1: moderare în așteptare / respinsă.
UPDATE public.videos
   SET effective_label = public.video_feed_label(moderation_status, NULL),
       updated_at = NOW()
 WHERE moderation_status IN ('pending_review', 'rejected')
   AND effective_label IS DISTINCT FROM public.video_feed_label(moderation_status, NULL);

-- Backfill 2: etichete reale adult/blocked ale clasificatorului pe clipuri aprobate.
UPDATE public.videos v
   SET effective_label = public.video_feed_label('approved', COALESCE(l.human_override_label, l.label)),
       updated_at = NOW()
  FROM public.video_safety_labels l
 WHERE l.video_id = v.id
   AND v.moderation_status = 'approved'
   AND (l.reviewed_by_human OR l.classifier_version <> 'auto_pending')
   AND v.effective_label IS DISTINCT FROM
       public.video_feed_label('approved', COALESCE(l.human_override_label, l.label));

COMMIT;
