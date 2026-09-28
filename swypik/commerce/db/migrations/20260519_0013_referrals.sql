-- 20260519_0013_referrals.sql
-- M1.3 — Referral attribution layer.
-- Each user has at most one short code (8 chars). When someone visits /r/<code>
-- a cookie swypik_ref=<code> is set. On signup, if cookie present (or anon_id
-- with prior actions), an attribution row is created and the referrer is
-- queued for reward (validated when invitee performs first qualifying action).
--
-- Antifraud: same IP+UA pair within X minutes is flagged via anti_fraud_score
-- (computed at attribution time and gates reward credit).

BEGIN;

------------------------------------------------------------
-- 1. referral_codes (1 row per user)
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS referral_codes (
  user_id          UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code             TEXT NOT NULL,
  total_invited    INTEGER NOT NULL DEFAULT 0,
  total_validated  INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT referral_codes_code_unique UNIQUE (code),
  CONSTRAINT referral_codes_code_format CHECK (code ~ '^[A-Z0-9]{6,12}$')
);

CREATE INDEX IF NOT EXISTS idx_referral_codes_code ON referral_codes (code);

------------------------------------------------------------
-- 2. referral_attributions (1 row per invitee)
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS referral_attributions (
  invitee_user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  referrer_user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code               TEXT NOT NULL,
  source             TEXT NOT NULL CHECK (source IN ('anon_cookie','explicit_code','share_link','signup_form')),
  anti_fraud_score   NUMERIC(4,3) NOT NULL DEFAULT 1.000,
  fraud_signals      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  validated_at       TIMESTAMPTZ,
  validation_action  TEXT,
  reward_event_id    UUID REFERENCES reward_events(id) ON DELETE SET NULL,
  CONSTRAINT referral_attributions_not_self CHECK (invitee_user_id <> referrer_user_id)
);

CREATE INDEX IF NOT EXISTS idx_referral_attr_referrer
  ON referral_attributions (referrer_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_referral_attr_unvalidated
  ON referral_attributions (referrer_user_id) WHERE validated_at IS NULL;

------------------------------------------------------------
-- 3. Auto-bump total_invited counter
------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_referral_attr_bump_counters()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE referral_codes
       SET total_invited = total_invited + 1, updated_at = now()
     WHERE user_id = NEW.referrer_user_id;
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' AND NEW.validated_at IS NOT NULL AND OLD.validated_at IS NULL THEN
    UPDATE referral_codes
       SET total_validated = total_validated + 1, updated_at = now()
     WHERE user_id = NEW.referrer_user_id;
    RETURN NEW;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_referral_attr_counters ON referral_attributions;
CREATE TRIGGER trg_referral_attr_counters
AFTER INSERT OR UPDATE ON referral_attributions
FOR EACH ROW EXECUTE FUNCTION fn_referral_attr_bump_counters();

INSERT INTO schema_migrations (version, applied_at)
VALUES ('20260519_0013_referrals', now())
ON CONFLICT DO NOTHING;

COMMIT;
