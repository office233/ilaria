-- 20260926_0061_mission_submissions_judging
--
-- Jurizarea misiunilor: un clip participă la O SINGURĂ misiune (legătura
-- video → misiune alimentează badge-ul din feed), plus cine a jurizat și când.
-- Statusuri: submitted → winner → paid, sau rejected.
-- ('approved' rămâne în CHECK pentru rândurile vechi; codul îl tratează ca
-- 'submitted'.)
-- Idempotent; nimic nu se șterge.

BEGIN;

ALTER TABLE creator_mission_submissions
  ADD COLUMN IF NOT EXISTS judged_by text,
  ADD COLUMN IF NOT EXISTS judged_at timestamptz,
  ADD COLUMN IF NOT EXISTS rejection_reason text;

-- Duplicatele istorice (același clip la mai multe misiuni): se păstrează cel
-- mai vechi rând activ, restul se marchează respinse înainte de indexul unic.
UPDATE creator_mission_submissions s
   SET status = 'rejected', rejection_reason = 'duplicate_video'
 WHERE s.video_id IS NOT NULL
   AND s.status IN ('submitted', 'approved')
   AND EXISTS (
     SELECT 1 FROM creator_mission_submissions o
      WHERE o.video_id = s.video_id
        AND o.status <> 'rejected'
        AND (o.submitted_at, o.id) < (s.submitted_at, s.id)
   );

CREATE UNIQUE INDEX IF NOT EXISTS idx_mission_submissions_video_active
  ON creator_mission_submissions (video_id)
  WHERE video_id IS NOT NULL AND status <> 'rejected';

COMMIT;
