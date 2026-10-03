-- Curatenie 2026-08-01: retragem functionalitatile moarte Trends si Battles.
--  * trending_now: tabela nefolosita (0 rows, /trends sters, cron detect-trends sters)
--  * community_posts format='battle': UI-ul /battles sters; formatul nu se mai
--    poate crea prin API. Postarile battle existente (0 in prod) devin istorice.
-- Restul formatelor Arena (merita, find_me, setup, drop, review_real,
-- dupe_hunt, roast_cart) raman functionale prin /post si /b/[slug].

DROP TABLE IF EXISTS trending_now;

-- Nu stergem community_posts (partajat de celelalte formate).
-- Blocam doar crearea de noi battles la nivel de date, defensiv:
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'community_posts') THEN
    -- inchidem orice battle activ ramas (nu exista in prod, dar defensiv)
    UPDATE community_posts SET status = 'closed' WHERE format = 'battle' AND status = 'active';
  END IF;
END $$;
