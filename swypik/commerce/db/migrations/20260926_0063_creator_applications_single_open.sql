-- 20260926_0063_creator_applications_single_open
--
-- Aplicarea ca creator: o singură aplicare deschisă (submitted/in_review)
-- per utilizator — două click-uri rapide nu mai creează două rânduri.
-- Duplicatele istorice: se păstrează cea mai recentă, restul → 'withdrawn'.
-- Idempotent; nimic nu se șterge.

BEGIN;

UPDATE creator_applications a
   SET status = 'withdrawn', updated_at = now()
 WHERE a.status IN ('submitted', 'in_review')
   AND EXISTS (
     SELECT 1 FROM creator_applications b
      WHERE b.user_id = a.user_id
        AND b.status IN ('submitted', 'in_review')
        AND (b.created_at, b.id) > (a.created_at, a.id)
   );

CREATE UNIQUE INDEX IF NOT EXISTS idx_creator_applications_one_open
  ON creator_applications (user_id)
  WHERE status IN ('submitted', 'in_review');

COMMIT;
