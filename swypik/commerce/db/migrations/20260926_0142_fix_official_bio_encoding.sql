-- 20260926_0142_fix_official_bio_encoding
-- Bio-ul contului oficial @swypik a fost salvat cu diacriticele pierdute („Descoper?? destina??ii”)
-- și vorbea despre zborurile demo arhivate în 20260926_0005. Îl înlocuim doar cât timp e încă
-- stricat (o editare ulterioară a proprietarului nu e suprascrisă). Idempotent.
UPDATE users
   SET bio = 'Contul oficial Swypik — clipuri, cumpărături și servicii într-o singură aplicație.',
       updated_at = now()
 WHERE id = '00000000-0000-4000-9000-0000000f1c1a'
   AND bio LIKE '%??%';
