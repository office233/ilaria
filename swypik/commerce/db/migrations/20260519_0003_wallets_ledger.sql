-- 20260519_0003_wallets_ledger.sql
-- The 3-currency wallet system: XP (status), Swyp Coins (spendable on
-- platform), Reputation (algorithmic trust score with decay).
--
-- IMPORTANT: Swyp Coins are platform credit only. They cannot be
-- redeemed for cash. Always grant via wallet_ledger so we have an
-- append-only audit trail (anti-fraud, ANPC compliance, GDPR exports).

BEGIN;

CREATE TABLE IF NOT EXISTS user_wallets (
  user_id           uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  xp                bigint NOT NULL DEFAULT 0 CHECK (xp >= 0),
  -- Lifetime XP earned (never decreases). level is derived in app: floor(sqrt(xp/100)).
  coins             integer NOT NULL DEFAULT 0 CHECK (coins >= 0),
  -- Spendable balance. Always touched via wallet_ledger.
  reputation        numeric(8,2) NOT NULL DEFAULT 0,
  -- Signed: penalties allowed. Subject to decay (job runs nightly).
  level             integer NOT NULL DEFAULT 1,
  -- Denormalised for fast feed/profile rendering.
  streak_current    integer NOT NULL DEFAULT 0,
  streak_best       integer NOT NULL DEFAULT 0,
  last_active_day   date,
  -- Lifetime totals (don't drop on coin spend).
  total_xp_earned   bigint NOT NULL DEFAULT 0,
  total_coins_earned integer NOT NULL DEFAULT 0,
  total_coins_spent integer NOT NULL DEFAULT 0,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wallets_level ON user_wallets(level DESC, xp DESC);
CREATE INDEX IF NOT EXISTS idx_wallets_streak ON user_wallets(streak_current DESC) WHERE streak_current > 0;

-- Append-only ledger. Every change to user_wallets MUST emit a row here.
CREATE TABLE IF NOT EXISTS wallet_ledger (
  id           bigserial PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('xp','coins','reputation')),
  delta        numeric(12,2) NOT NULL,        -- signed; allows fractional reputation
  balance_after numeric(12,2) NOT NULL,        -- snapshot for fast audit
  reason       text NOT NULL,                  -- 'mission_claim'|'vote_cast'|'post_created'|'battle_won'|'coin_spend_boost'|'bounty_payout'|'decay'|'admin_adjust'|...
  ref_type     text,                           -- 'mission'|'post'|'vote'|'battle'|'bounty'|...
  ref_id       uuid,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ledger_user_recent ON wallet_ledger(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_ref ON wallet_ledger(ref_type, ref_id) WHERE ref_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ledger_reason ON wallet_ledger(reason, created_at DESC);

-- Atomic wallet mutation. Use this from app code instead of UPDATE user_wallets.
-- Returns the new balance for the requested kind.
CREATE OR REPLACE FUNCTION wallet_apply(
  p_user_id  uuid,
  p_kind     text,
  p_delta    numeric,
  p_reason   text,
  p_ref_type text DEFAULT NULL,
  p_ref_id   uuid DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS numeric
LANGUAGE plpgsql AS $$
DECLARE
  v_balance numeric;
BEGIN
  IF p_delta = 0 THEN RAISE EXCEPTION 'wallet_apply: delta=0 not allowed'; END IF;
  IF p_kind NOT IN ('xp','coins','reputation') THEN
    RAISE EXCEPTION 'wallet_apply: invalid kind %', p_kind;
  END IF;

  -- Ensure row exists.
  INSERT INTO user_wallets(user_id) VALUES (p_user_id)
    ON CONFLICT (user_id) DO NOTHING;

  IF p_kind = 'xp' THEN
    UPDATE user_wallets
       SET xp = xp + p_delta::bigint,
           total_xp_earned = CASE WHEN p_delta > 0 THEN total_xp_earned + p_delta::bigint ELSE total_xp_earned END,
           level = GREATEST(1, FLOOR(SQRT((xp + p_delta::bigint)::numeric / 100))::int),
           updated_at = now()
     WHERE user_id = p_user_id
     RETURNING xp INTO v_balance;
  ELSIF p_kind = 'coins' THEN
    UPDATE user_wallets
       SET coins = coins + p_delta::int,
           total_coins_earned = CASE WHEN p_delta > 0 THEN total_coins_earned + p_delta::int ELSE total_coins_earned END,
           total_coins_spent  = CASE WHEN p_delta < 0 THEN total_coins_spent  + (-p_delta)::int ELSE total_coins_spent END,
           updated_at = now()
     WHERE user_id = p_user_id
     RETURNING coins INTO v_balance;
    IF v_balance < 0 THEN
      RAISE EXCEPTION 'wallet_apply: insufficient coins (balance would be %)', v_balance;
    END IF;
  ELSE  -- reputation
    UPDATE user_wallets
       SET reputation = reputation + p_delta,
           updated_at = now()
     WHERE user_id = p_user_id
     RETURNING reputation INTO v_balance;
  END IF;

  INSERT INTO wallet_ledger(user_id, kind, delta, balance_after, reason, ref_type, ref_id, metadata)
       VALUES (p_user_id, p_kind, p_delta, v_balance, p_reason, p_ref_type, p_ref_id, p_metadata);

  RETURN v_balance;
END $$;

-- Streak bump: idempotent per day. Award XP/coins per consecutive day.
-- Caller: on first authenticated action of the day (vote, post, login).
CREATE OR REPLACE FUNCTION wallet_bump_streak(p_user_id uuid)
RETURNS TABLE(streak integer, xp_awarded integer, coins_awarded integer)
LANGUAGE plpgsql AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Europe/Bucharest')::date;
  v_last  date;
  v_new_streak integer;
  v_xp integer := 10;
  v_coins integer := 5;
BEGIN
  INSERT INTO user_wallets(user_id) VALUES (p_user_id) ON CONFLICT (user_id) DO NOTHING;

  SELECT last_active_day INTO v_last FROM user_wallets WHERE user_id = p_user_id;

  IF v_last = v_today THEN
    -- Already counted today, no-op.
    SELECT streak_current INTO v_new_streak FROM user_wallets WHERE user_id = p_user_id;
    RETURN QUERY SELECT v_new_streak, 0, 0;
    RETURN;
  ELSIF v_last = v_today - 1 THEN
    UPDATE user_wallets SET streak_current = streak_current + 1,
                            streak_best    = GREATEST(streak_best, streak_current + 1),
                            last_active_day = v_today,
                            updated_at = now()
     WHERE user_id = p_user_id RETURNING streak_current INTO v_new_streak;
  ELSE
    UPDATE user_wallets SET streak_current = 1,
                            streak_best    = GREATEST(streak_best, 1),
                            last_active_day = v_today,
                            updated_at = now()
     WHERE user_id = p_user_id RETURNING streak_current INTO v_new_streak;
  END IF;

  -- Scale bonus with streak (cap at 30 days).
  v_xp    := LEAST(v_new_streak, 30) * 10;
  v_coins := LEAST(v_new_streak, 30) * 5;
  PERFORM wallet_apply(p_user_id, 'xp',    v_xp,    'streak_day', NULL, NULL, jsonb_build_object('streak', v_new_streak));
  PERFORM wallet_apply(p_user_id, 'coins', v_coins, 'streak_day', NULL, NULL, jsonb_build_object('streak', v_new_streak));

  RETURN QUERY SELECT v_new_streak, v_xp, v_coins;
END $$;

COMMIT;
