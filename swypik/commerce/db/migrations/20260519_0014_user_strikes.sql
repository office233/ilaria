-- ============================================================================
-- 20260519_0014_user_strikes.sql
-- ETAPA 5 — Strike system + user_risk_scores
--
-- Idea: every time T&S helpers (moderateText / labelProduct / labelVideo)
-- reject or hide user-submitted content, we record a strike against the user.
-- A trigger keeps a running risk score, and once it crosses a threshold the
-- user is automatically suspended (`users.status='suspended'` +
-- `users.suspended_until=NOW()+N`).
--
-- The suspension is enforced at the API layer via `requireNotSuspended()`.
-- Operators can override via `users.status='active'` + clear suspended_until.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- user_strikes — append-only log of every moderation hit per user.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_strikes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  severity      int  NOT NULL CHECK (severity BETWEEN 1 AND 10),
  -- 'blocked' (illegal/hard), 'adult', 'sensitive', 'spam', 'manual'
  label         text NOT NULL,
  -- where the violation came from
  context       text NOT NULL CHECK (context IN (
    'comment','bio','display_name','post','video','product','search','report','manual'
  )),
  reason        text,
  ref_type      text,        -- e.g. 'comment','video','community_post','marketplace_product'
  ref_id        text,        -- string so we can hold uuid/bigint
  signals       jsonb NOT NULL DEFAULT '{}'::jsonb,
  reasons       text[]       NOT NULL DEFAULT ARRAY[]::text[],
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz,                          -- when the score contribution fades
  status        text NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','expired','revoked')),
  revoked_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  revoked_at    timestamptz,
  notes         text
);

CREATE INDEX IF NOT EXISTS user_strikes_user_idx
  ON user_strikes (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS user_strikes_active_idx
  ON user_strikes (user_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS user_strikes_ref_idx
  ON user_strikes (ref_type, ref_id) WHERE ref_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS user_strikes_expires_idx
  ON user_strikes (expires_at) WHERE status = 'active' AND expires_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- user_risk_scores — denormalised running totals.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_risk_scores (
  user_id          uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  score            numeric(8,2) NOT NULL DEFAULT 0,
  strike_count     int NOT NULL DEFAULT 0,
  blocked_count    int NOT NULL DEFAULT 0,
  adult_count      int NOT NULL DEFAULT 0,
  sensitive_count  int NOT NULL DEFAULT 0,
  last_strike_at   timestamptz,
  last_decay_at    timestamptz NOT NULL DEFAULT now(),
  computed_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_risk_scores_score_idx
  ON user_risk_scores (score DESC) WHERE score > 0;

-- ---------------------------------------------------------------------------
-- Trigger — every new strike updates the user's risk score and may suspend.
-- Thresholds:
--   score >=  5  → soft warning (no action, surfaced in admin)
--   score >= 10  → suspend 7 days  (status='suspended')
--   score >= 20  → suspend 30 days
--   score >= 40  → suspend 365 days (effectively permanent, admin override only)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION apply_user_strike() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  new_score      numeric(8,2);
  suspend_until  timestamptz := NULL;
  suspend_reason text := NULL;
BEGIN
  -- Default expiry: 90 days for blocked/adult, 30 days for sensitive/spam.
  IF NEW.expires_at IS NULL THEN
    NEW.expires_at := NEW.created_at + CASE
      WHEN NEW.label IN ('blocked','adult') THEN INTERVAL '90 days'
      ELSE INTERVAL '30 days'
    END;
  END IF;

  -- Upsert running totals.
  INSERT INTO user_risk_scores (
    user_id, score, strike_count, blocked_count, adult_count, sensitive_count,
    last_strike_at, computed_at
  )
  VALUES (
    NEW.user_id,
    NEW.severity,
    1,
    CASE WHEN NEW.label = 'blocked'  THEN 1 ELSE 0 END,
    CASE WHEN NEW.label = 'adult'    THEN 1 ELSE 0 END,
    CASE WHEN NEW.label = 'sensitive' THEN 1 ELSE 0 END,
    NEW.created_at,
    now()
  )
  ON CONFLICT (user_id) DO UPDATE
    SET score           = user_risk_scores.score + NEW.severity,
        strike_count    = user_risk_scores.strike_count + 1,
        blocked_count   = user_risk_scores.blocked_count
                          + CASE WHEN NEW.label = 'blocked'   THEN 1 ELSE 0 END,
        adult_count     = user_risk_scores.adult_count
                          + CASE WHEN NEW.label = 'adult'     THEN 1 ELSE 0 END,
        sensitive_count = user_risk_scores.sensitive_count
                          + CASE WHEN NEW.label = 'sensitive' THEN 1 ELSE 0 END,
        last_strike_at  = NEW.created_at,
        computed_at     = now()
    RETURNING score INTO new_score;

  IF new_score IS NULL THEN
    SELECT score INTO new_score FROM user_risk_scores WHERE user_id = NEW.user_id;
  END IF;

  -- Decide suspension window.
  IF new_score >= 40 THEN
    suspend_until  := now() + INTERVAL '365 days';
    suspend_reason := format('auto_strike score=%s (>=40 — long-term)', new_score);
  ELSIF new_score >= 20 THEN
    suspend_until  := now() + INTERVAL '30 days';
    suspend_reason := format('auto_strike score=%s (>=20)', new_score);
  ELSIF new_score >= 10 THEN
    suspend_until  := now() + INTERVAL '7 days';
    suspend_reason := format('auto_strike score=%s (>=10)', new_score);
  END IF;

  IF suspend_until IS NOT NULL THEN
    UPDATE users
       SET status            = 'suspended',
           suspended_until   = GREATEST(COALESCE(suspended_until, now()), suspend_until),
           suspension_reason = suspend_reason
     WHERE id = NEW.user_id
       AND status <> 'deleted';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_user_strikes_apply ON user_strikes;
CREATE TRIGGER trg_user_strikes_apply
  BEFORE INSERT ON user_strikes
  FOR EACH ROW
  EXECUTE FUNCTION apply_user_strike();

-- ---------------------------------------------------------------------------
-- Decay helper — call from a daily cron to fade old strikes.
-- Marks strikes past expires_at as 'expired' and rebuilds the score row.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION decay_user_strikes() RETURNS TABLE(expired int, recomputed int)
LANGUAGE plpgsql AS $$
DECLARE
  v_expired   int := 0;
  v_recomp    int := 0;
BEGIN
  WITH up AS (
    UPDATE user_strikes
       SET status = 'expired'
     WHERE status = 'active'
       AND expires_at IS NOT NULL
       AND expires_at <= now()
    RETURNING user_id
  )
  SELECT COUNT(*) INTO v_expired FROM up;

  -- Recompute aggregates for every user that has at least one expired/revoked
  -- strike, plus active ones.
  WITH agg AS (
    SELECT user_id,
           COALESCE(SUM(severity) FILTER (WHERE status = 'active'), 0)::numeric(8,2) AS score,
           COUNT(*)                  AS strike_count,
           COUNT(*) FILTER (WHERE status='active' AND label='blocked')   AS blocked_count,
           COUNT(*) FILTER (WHERE status='active' AND label='adult')     AS adult_count,
           COUNT(*) FILTER (WHERE status='active' AND label='sensitive') AS sensitive_count,
           MAX(created_at) FILTER (WHERE status='active')                AS last_strike_at
      FROM user_strikes
     GROUP BY user_id
  )
  INSERT INTO user_risk_scores
    (user_id, score, strike_count, blocked_count, adult_count, sensitive_count,
     last_strike_at, last_decay_at, computed_at)
  SELECT user_id, score, strike_count, blocked_count, adult_count, sensitive_count,
         last_strike_at, now(), now()
    FROM agg
  ON CONFLICT (user_id) DO UPDATE
    SET score           = EXCLUDED.score,
        strike_count    = EXCLUDED.strike_count,
        blocked_count   = EXCLUDED.blocked_count,
        adult_count     = EXCLUDED.adult_count,
        sensitive_count = EXCLUDED.sensitive_count,
        last_strike_at  = EXCLUDED.last_strike_at,
        last_decay_at   = now(),
        computed_at     = now();

  GET DIAGNOSTICS v_recomp = ROW_COUNT;

  -- Auto-lift suspensions that expired naturally.
  UPDATE users
     SET status            = 'active',
         suspended_until   = NULL,
         suspension_reason = NULL
   WHERE status = 'suspended'
     AND suspended_until IS NOT NULL
     AND suspended_until <= now();

  RETURN QUERY SELECT v_expired, v_recomp;
END;
$$;

INSERT INTO schema_migrations(version)
VALUES ('20260519_0014_user_strikes')
ON CONFLICT DO NOTHING;

COMMIT;
