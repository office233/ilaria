-- 20260926_0131_feed_rank_weights
--
-- Ponderile noului ranker (lib/feed/config.ts) în tabela existentă feed_weights,
-- cu prefixul `rank_` (cheile vechi w_* rămân pentru /api/feed/universal).
-- Varianta B de A/B: aceleași chei cu prefixul `b:` (ex. `b:rank_w_share`).
-- Ordinea de precedență: feed_weights > env FEED_RANK_<KEY> > defaults din cod.
-- Idempotent (ON CONFLICT DO NOTHING — nu suprascrie valori tunate manual).

BEGIN;

INSERT INTO feed_weights (key, value, description) VALUES
  ('rank_w_complete',               30, 'Pondere rata de completare (netezită)'),
  ('rank_w_watch',                  20, 'Pondere fracțiunea medie vizionată per viewer'),
  ('rank_w_like',                   25, 'Pondere rata like / impresii'),
  ('rank_w_comment',                30, 'Pondere rata comentarii / impresii'),
  ('rank_w_share',                  40, 'Pondere rata share / impresii'),
  ('rank_w_save',                   30, 'Pondere rata save / impresii'),
  ('rank_w_follow',                 40, 'Pondere rata follow din clip / impresii'),
  ('rank_w_skip',                   25, 'Penalizare rata skip rapid'),
  ('rank_w_negative',               60, 'Penalizare rata not_interested + report'),
  ('rank_w_recency',                 8, 'Bonus prospețime (decădere exponențială)'),
  ('rank_w_following',               6, 'Bonus dacă viewerul urmărește creatorul'),
  ('rank_w_topic',                   5, 'Bonus potrivire cu interesele explicite (0..1)'),
  ('rank_prior_strength',           20, 'Netezire bayesiană: impresii „virtuale” la media platformei'),
  ('rank_recency_half_life_h',      36, 'Timp de înjumătățire prospețime (ore)'),
  ('rank_creator_window',            4, 'Max 1 clip per creator în N sloturi consecutive'),
  ('rank_explore_every',             5, 'Fiecare al N-lea slot = explorare (Thompson)'),
  ('rank_explore_epsilon',        0.10, 'Probabilitate suplimentară de explorare per slot'),
  ('rank_explore_max_age_h',        72, 'Vârsta maximă a unui clip „nou” (ore)'),
  ('rank_explore_max_impressions', 200, 'Impresii garantate înainte ca un clip să iasă din pool-ul de explorare'),
  ('rank_snapshot_size',           200, 'Lungimea clasamentului salvat pentru paginare'),
  ('rank_snapshot_ttl_s',         1800, 'TTL snapshot clasament (secunde)'),
  ('rank_seen_ttl_s',            86400, 'TTL seen-set per viewer (secunde)'),
  ('rank_seen_max',               2000, 'Câte clipuri servite se rețin per viewer')
ON CONFLICT (key) DO NOTHING;

COMMIT;
