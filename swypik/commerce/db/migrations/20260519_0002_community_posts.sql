-- 20260519_0002_community_posts.sql
-- Foundation for the "social shopping game": every Swypik post is a structured
-- format the community can vote on, remix, beat, or shop from.
--
-- Formats (post_format):
--   merita          — single product, "worth it / not worth it" poll
--   battle          — 2..4 products in a duel; community votes per option
--   find_me         — request: "find me X under Y RON"; replies are responses
--   setup           — themed collection of products (desk, gym, skincare, ...)
--   drop            — seller/creator limited-time offer
--   review_real     — post-purchase test
--   dupe_hunt       — request alternatives to a brand/product
--   roast_cart      — share cart, ask community to optimize/critique
--
-- A post points to zero, one, or many products through `community_post_items`.
-- Votes are recorded per option (battle/merita) or as binary worth-it
-- (single-product posts).

BEGIN;

CREATE TABLE IF NOT EXISTS community_posts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text UNIQUE,
  author_user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'merita' | 'battle' | 'find_me' | 'setup' | 'drop' | 'review_real' | 'dupe_hunt' | 'roast_cart'
  format          text NOT NULL CHECK (format IN (
                    'merita','battle','find_me','setup','drop','review_real','dupe_hunt','roast_cart'
                  )),
  title           text NOT NULL,
  body            text,
  budget_minor    integer,            -- for find_me / dupe_hunt / roast_cart
  budget_currency text DEFAULT 'RON',
  -- Optional attached video (for clips / reactions / unboxings).
  video_id        uuid REFERENCES videos(id) ON DELETE SET NULL,
  -- Optional mission backlink (post fulfils a creator mission).
  mission_id      uuid REFERENCES creator_missions(id) ON DELETE SET NULL,
  -- Denormalised counters for fast feed sorting.
  vote_count      integer NOT NULL DEFAULT 0,
  comment_count   integer NOT NULL DEFAULT 0,
  save_count      integer NOT NULL DEFAULT 0,
  share_count     integer NOT NULL DEFAULT 0,
  view_count      integer NOT NULL DEFAULT 0,
  -- 0..100, computed by ranker. Used by the Arena sort.
  hot_score       numeric(6,2) NOT NULL DEFAULT 0,
  status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','closed','removed','flagged')),
  is_adult        boolean NOT NULL DEFAULT FALSE,
  ends_at         timestamptz,       -- battle/drop have lifetimes
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_posts_format_active
  ON community_posts(format, hot_score DESC) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_posts_author_recent
  ON community_posts(author_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_ends
  ON community_posts(ends_at) WHERE ends_at IS NOT NULL AND status = 'active';
CREATE INDEX IF NOT EXISTS idx_posts_mission
  ON community_posts(mission_id) WHERE mission_id IS NOT NULL;

-- Items attached to a post (1..N products). For battles, `option_key` is
-- 'a','b','c','d'; for setup it's a free slot ('desk','chair',...); for
-- merita/review_real/drop typically a single row with option_key='main'.
CREATE TABLE IF NOT EXISTS community_post_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id         uuid NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  product_id      uuid REFERENCES marketplace_products(id) ON DELETE SET NULL,
  -- External link captured when there's no product match yet (find_me, dupe_hunt).
  external_url    text,
  external_image  text,
  external_title  text,
  external_price_minor integer,
  external_currency text,
  option_key      text NOT NULL DEFAULT 'main',
  label           text,
  vote_count      integer NOT NULL DEFAULT 0,
  position        integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (product_id IS NOT NULL OR external_url IS NOT NULL)
);

-- Postgres requires an expression index for UNIQUE over COALESCE.
CREATE UNIQUE INDEX IF NOT EXISTS uq_post_items_dedup
  ON community_post_items(post_id, option_key, COALESCE(product_id::text, external_url));

CREATE INDEX IF NOT EXISTS idx_post_items_post
  ON community_post_items(post_id, position);
CREATE INDEX IF NOT EXISTS idx_post_items_product
  ON community_post_items(product_id) WHERE product_id IS NOT NULL;

-- Votes. One user can vote once per post (rebumped on change).
-- For merita: option_key ∈ {'worth_it','not_worth_it'}
-- For battle: option_key ∈ {'a','b','c','d'} (matches post_items.option_key)
CREATE TABLE IF NOT EXISTS community_post_votes (
  post_id     uuid NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  option_key  text NOT NULL,
  weight      smallint NOT NULL DEFAULT 1 CHECK (weight BETWEEN -1 AND 5),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_post_votes_post_option
  ON community_post_votes(post_id, option_key);

-- Replies for find_me / dupe_hunt: a reply IS a community_post of format
-- 'merita' (or with a single product) that targets another post.
CREATE TABLE IF NOT EXISTS community_post_replies (
  parent_post_id  uuid NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  reply_post_id   uuid NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  upvotes         integer NOT NULL DEFAULT 0,
  is_accepted     boolean NOT NULL DEFAULT FALSE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (parent_post_id, reply_post_id)
);

CREATE INDEX IF NOT EXISTS idx_post_replies_parent
  ON community_post_replies(parent_post_id, upvotes DESC);

-- Reuse the touch trigger from missions migration.
DROP TRIGGER IF EXISTS trg_community_posts_touch ON community_posts;
CREATE TRIGGER trg_community_posts_touch
  BEFORE UPDATE ON community_posts
  FOR EACH ROW EXECUTE FUNCTION trg_creator_missions_touch();

DROP TRIGGER IF EXISTS trg_community_post_votes_touch ON community_post_votes;
CREATE TRIGGER trg_community_post_votes_touch
  BEFORE UPDATE ON community_post_votes
  FOR EACH ROW EXECUTE FUNCTION trg_creator_missions_touch();

COMMIT;
