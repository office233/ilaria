-- 20260519_0001_creator_missions.sql
-- Foundation for the Creator Loop: sellers (or platform) post missions,
-- creators submit videos, get scored, win prizes (SWYP or RON).
-- UI to follow; this lays the schema + indexes so we can build incrementally.

BEGIN;

CREATE TABLE IF NOT EXISTS creator_missions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug               text UNIQUE NOT NULL,
  seller_id          uuid REFERENCES sellers(id) ON DELETE SET NULL,
  product_id         uuid REFERENCES marketplace_products(id) ON DELETE SET NULL,
  title              text NOT NULL,
  brief              text,
  -- "merita-sau-nu" | "sub-50" | "unboxing" | "dupe-battle" | "test-real" | ...
  format_hint        text,
  -- Reward bucket in minor units (RON bani, or whole SWYP coins).
  prize_amount_minor integer NOT NULL DEFAULT 0,
  prize_currency     text NOT NULL DEFAULT 'SWYP' CHECK (prize_currency IN ('SWYP','RON','EUR')),
  -- Cap winners. NULL = unlimited.
  max_winners        integer,
  -- Bounty per qualifying sale on top of the fixed prize.
  bounty_per_sale_minor integer NOT NULL DEFAULT 0,
  starts_at          timestamptz NOT NULL DEFAULT now(),
  ends_at            timestamptz,
  status             text NOT NULL DEFAULT 'active'
                       CHECK (status IN ('draft','active','closed','archived')),
  metadata           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_missions_active
  ON creator_missions(status, ends_at DESC) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_missions_product
  ON creator_missions(product_id) WHERE product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_missions_seller
  ON creator_missions(seller_id) WHERE seller_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS creator_mission_submissions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id       uuid NOT NULL REFERENCES creator_missions(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id         uuid REFERENCES videos(id) ON DELETE SET NULL,
  status           text NOT NULL DEFAULT 'submitted'
                     CHECK (status IN ('submitted','approved','rejected','winner','paid')),
  -- 0..100, computed by ai-scoring pipeline (hook/caption/visual/relevance).
  ai_score         numeric(5,2),
  -- Live attribution counters (denormalized for fast leaderboard).
  views            integer NOT NULL DEFAULT 0,
  likes            integer NOT NULL DEFAULT 0,
  clicks           integer NOT NULL DEFAULT 0,
  add_to_carts     integer NOT NULL DEFAULT 0,
  sales            integer NOT NULL DEFAULT 0,
  -- Paid out total (minor units) and when.
  payout_minor     integer NOT NULL DEFAULT 0,
  payout_currency  text NOT NULL DEFAULT 'SWYP',
  paid_at          timestamptz,
  submitted_at     timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mission_id, user_id, video_id)
);

CREATE INDEX IF NOT EXISTS idx_submissions_mission_status
  ON creator_mission_submissions(mission_id, status);
CREATE INDEX IF NOT EXISTS idx_submissions_user_recent
  ON creator_mission_submissions(user_id, submitted_at DESC);
-- Leaderboard query helper: top submissions per mission by sales then ai_score.
CREATE INDEX IF NOT EXISTS idx_submissions_leaderboard
  ON creator_mission_submissions(mission_id, sales DESC, ai_score DESC NULLS LAST);

-- updated_at trigger (reuses pattern from other tables).
CREATE OR REPLACE FUNCTION trg_creator_missions_touch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS trg_creator_missions_touch ON creator_missions;
CREATE TRIGGER trg_creator_missions_touch
  BEFORE UPDATE ON creator_missions
  FOR EACH ROW EXECUTE FUNCTION trg_creator_missions_touch();

DROP TRIGGER IF EXISTS trg_creator_mission_submissions_touch ON creator_mission_submissions;
CREATE TRIGGER trg_creator_mission_submissions_touch
  BEFORE UPDATE ON creator_mission_submissions
  FOR EACH ROW EXECUTE FUNCTION trg_creator_missions_touch();

COMMIT;
