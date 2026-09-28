-- 20260731_0001_drop_points_systems.sql
-- Șterge complet sistemele de puncte/gamification (Sistemul A: puncte SWYP,
-- Sistemul B: XP/coins/reputation). Portofelul de BANI REALI
-- (wallet_balances, wallet_ledger_entries, payout_requests) NU este atins.
-- Decizie: o singură monedă viitoare (SWYP on-chain) va fi reconstruită
-- de la zero pe un ledger unificat; soldurile de puncte existente se pierd
-- intenționat (confirmat 2026-07-31).
-- Idempotent: totul cu IF EXISTS.

-- ── Triggere & funcții (înainte de tabele) ──────────────────────────────
DROP TRIGGER IF EXISTS trg_reward_events_credit_wallet ON reward_events;
DROP FUNCTION IF EXISTS reward_events_credit_wallet() CASCADE;
DROP FUNCTION IF EXISTS wallet_apply(uuid, text, numeric, text, text, uuid, jsonb) CASCADE;
DROP FUNCTION IF EXISTS wallet_apply(uuid, text, numeric, text, text, uuid) CASCADE;
-- orice alte supraîncărcări rămase
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'wallet_apply'
  LOOP
    EXECUTE 'DROP FUNCTION ' || r.sig || ' CASCADE';
  END LOOP;
END $$;

-- ── Sistemul A: puncte SWYP / gamification ──────────────────────────────
DROP TABLE IF EXISTS challenge_entries CASCADE;
DROP TABLE IF EXISTS daily_challenges CASCADE;
DROP TABLE IF EXISTS video_milestones CASCADE;
DROP TABLE IF EXISTS reward_events CASCADE;
DROP TABLE IF EXISTS reward_rules CASCADE;
DROP TABLE IF EXISTS wallet_transactions CASCADE; -- ledger-ul de PUNCTE (nu cel de bani)
DROP TABLE IF EXISTS swyp_wallets CASCADE;
DROP TABLE IF EXISTS user_streaks CASCADE;

-- ── Sistemul B: XP / coins / reputation ─────────────────────────────────
DROP TABLE IF EXISTS wallet_ledger CASCADE;        -- NU wallet_ledger_entries!
DROP TABLE IF EXISTS user_wallets CASCADE;
DROP TABLE IF EXISTS daily_mission_templates CASCADE;
DROP TABLE IF EXISTS user_daily_missions CASCADE;

-- ── Coloane rămase pe tabele care supraviețuiesc ────────────────────────
ALTER TABLE users DROP COLUMN IF EXISTS swyp_streak;
ALTER TABLE users DROP COLUMN IF EXISTS swyp_streak_last_claim_at;
ALTER TABLE referral_attributions DROP COLUMN IF EXISTS reward_event_id;

-- Verificare de siguranță: tabelele de bani reali TREBUIE să existe încă.
DO $$
BEGIN
  IF to_regclass('public.wallet_balances') IS NULL
     OR to_regclass('public.wallet_ledger_entries') IS NULL THEN
    RAISE EXCEPTION 'SAFETY: real-money wallet tables missing — aborting';
  END IF;
END $$;
