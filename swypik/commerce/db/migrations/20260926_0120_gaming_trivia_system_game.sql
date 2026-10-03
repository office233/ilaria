-- Gaming: fix trivia 500 (audit G1). /api/gaming/trivia/answer scrie în
-- gaming_scores cu game_id = 'trivia_daily', dar gaming_scores.game_id are FK
-- spre gaming_games(id) și rândul nu exista → fiecare rundă de trivia pica
-- după ce tokenul era deja consumat. Rândul e „sistem”: inactiv și cu
-- source_type = 'system', deci nu apare în /api/gaming/games și nu poate fi
-- pornit prin /api/gaming/session/start. Idempotent.

INSERT INTO gaming_games (id, title, slug, category, source_type, embed_url, thumbnail_url, reward_enabled, is_active)
VALUES ('trivia_daily', 'Daily Trivia', 'trivia-daily', 'trivia', 'system', '', '', true, false)
ON CONFLICT (id) DO UPDATE
   SET source_type = 'system',
       is_active = false;
