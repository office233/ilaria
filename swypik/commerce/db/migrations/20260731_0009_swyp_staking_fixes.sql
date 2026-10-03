-- 20260731_0009_swyp_staking_fixes.sql
-- Fix-uri din auditul complet SWYP (2026-07-31).
--
-- 1. Stare nouă 'bonus_pending': principalul a fost returnat la scadență, dar
--    bugetul lunar de surplus era epuizat, deci bonusul se plătește când apare
--    surplus. Înainte foloseam un truc matured→active care lăsa rândul într-o
--    stare ruptă dacă procesul murea la mijloc.
-- 2. Config pentru valorile hardcodate în mining (streak, durată sesiune).
-- Idempotent.

ALTER TABLE swyp_stakes DROP CONSTRAINT IF EXISTS swyp_stakes_status_check;
ALTER TABLE swyp_stakes ADD CONSTRAINT swyp_stakes_status_check
  CHECK (status IN ('active', 'bonus_pending', 'matured', 'withdrawn_early'));

CREATE INDEX IF NOT EXISTS idx_swyp_stakes_pending
  ON swyp_stakes (status, matures_at) WHERE status IN ('active', 'bonus_pending');

-- Parametrii de mining, scoși din cod în config (schimbare fără deploy).
INSERT INTO platform_config (key, value) VALUES
  ('swyp_mining_session_hours',    '24'::jsonb),
  ('swyp_streak_bonus_per_day_bps', '1000'::jsonb),  -- +10%/zi
  ('swyp_streak_bonus_max_bps',     '10000'::jsonb), -- plafon +100%
  ('swyp_streak_grace_hours',       '48'::jsonb)
ON CONFLICT (key) DO NOTHING;
