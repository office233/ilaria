-- Migration: 20260519_0016_fk_indexes.sql
-- Adds covering indexes on FK columns that lacked them. Idempotent AND tolerant:
-- unele tabele/coloane au fost eliminate ulterior (ex. reward_event_id la
-- curatenia sistemului de puncte), asa ca fiecare index se creeaza doar daca
-- tabela si coloana inca exista.

DO $$
DECLARE
  spec record;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('idx_anon_actions_attributed_user_id',              'anon_actions',                'attributed_user_id'),
      ('idx_anon_post_votes_attributed_user_id',           'anon_post_votes',             'attributed_user_id'),
      ('idx_community_post_replies_reply_post_id',         'community_post_replies',      'reply_post_id'),
      ('idx_community_posts_video_id',                     'community_posts',             'video_id'),
      ('idx_community_post_votes_user_id',                 'community_post_votes',        'user_id'),
      ('idx_creator_mission_submissions_video_id',         'creator_mission_submissions', 'video_id'),
      ('idx_customer_sessions_customer_id',                'customer_sessions',           'customer_id'),
      ('idx_product_safety_labels_reviewed_by_user_id',    'product_safety_labels',       'reviewed_by_user_id'),
      ('idx_referral_attributions_reward_event_id',        'referral_attributions',       'reward_event_id'),
      ('idx_user_daily_missions_template_id',              'user_daily_missions',         'template_id'),
      ('idx_user_strikes_revoked_by',                      'user_strikes',                'revoked_by'),
      ('idx_video_product_votes_user_id',                  'video_product_votes',         'user_id'),
      ('idx_video_safety_labels_reviewed_by_user_id',      'video_safety_labels',         'reviewed_by_user_id')
    ) AS v(idx_name, tbl, col)
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = spec.tbl AND column_name = spec.col
    ) THEN
      EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I (%I)', spec.idx_name, spec.tbl, spec.col);
    END IF;
  END LOOP;
END $$;
