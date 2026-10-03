-- Per-table autovacuum tuning for hot small tables.
-- Default postgres scale_factor is 0.20 which is too lax for tables with
-- frequent UPDATE/DELETE and small row counts (notifications, fx_rates,
-- community_post_items etc.) where dead-tuple ratio reaches >50% before
-- autovacuum kicks in. Aggressive thresholds keep them lean.
-- Idempotent: ALTER TABLE ... SET (...) overwrites prior values.

DO $$
DECLARE
  t text;
  small_threshold int := 50;
  med_threshold int := 100;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'notifications',
    'fx_rates',
    'community_post_items',
    'community_post_votes',
    'swyp_wallets'
  ])
  LOOP
    IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE c.relname = t AND n.nspname = 'public' AND c.relkind = 'r') THEN
      EXECUTE format(
        'ALTER TABLE public.%I SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_vacuum_threshold = %s, autovacuum_analyze_scale_factor = 0.05, autovacuum_analyze_threshold = %s)',
        t, small_threshold, small_threshold);
    END IF;
  END LOOP;

  FOR t IN SELECT unnest(ARRAY[
    'reward_events',
    'anon_sessions',
    'video_processing_jobs'
  ])
  LOOP
    IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE c.relname = t AND n.nspname = 'public' AND c.relkind = 'r') THEN
      EXECUTE format(
        'ALTER TABLE public.%I SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_vacuum_threshold = %s, autovacuum_analyze_scale_factor = 0.05, autovacuum_analyze_threshold = %s)',
        t, med_threshold, med_threshold);
    END IF;
  END LOOP;
END$$;
