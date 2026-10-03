-- 20260730_0005_feed_algo_monetization.sql
-- FRONT 3: algoritm feed + remunerație creatori.
--
-- 1. feed_weights          — ponderi configurabile pentru formula de scoring
-- 2. video_attributions    — atribuire vânzare → clip (fereastră 7 zile)
-- 3. creator_fund_pools    — fond lunar creatori (pool distribuit pe watch-time)
-- 4. creator_fund_payouts  — cotele individuale; plata efectivă merge prin
--                            wallet_apply()/wallet_ledger (NU alt sistem).
--
-- Event tracking-ul granular există deja în feed_events
-- (20260510_0001 + 20260513_0008). NU se creează altă tabelă de events;
-- adăugăm doar un index compus pentru agregările pe zi/creator.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Ponderi configurabile pentru scoring (fallback pe env / defaults în cod)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS feed_weights (
  key         text PRIMARY KEY,
  value       numeric(12,4) NOT NULL,
  description text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO feed_weights (key, value, description) VALUES
  ('w_freshness',            1.00, 'Pondere freshness (0..5, decade in 3 zile)'),
  ('w_engagement',           1.00, 'Pondere engagement_rate (rank 14d comprimat log)'),
  ('w_conversion',           1.50, 'Pondere conversion_rate (purchase/add_to_cart per view)'),
  ('w_follow_bonus',         3.00, 'Bonus daca viewerul urmareste creatorul'),
  ('w_saturation',           1.00, 'Pondere penalizare saturatie (acelasi creator vazut des)'),
  ('small_creator_boost',    8.00, 'Boost clipuri <48h de la creatori <small_creator_followers'),
  ('small_creator_followers', 1000, 'Prag followers sub care un creator e "mic"'),
  ('small_creator_hours',      48, 'Fereastra (ore) in care se aplica boostul de creator mic'),
  ('daily_views_cap',       20000, 'Plafon vizualizari/zi per business (creator); peste => penalizare'),
  ('daily_cap_penalty',        25, 'Penalizare aplicata clipurilor unui creator peste plafon'),
  ('rotation_penalty',          6, 'Penalizare per clip deja servit viewerului azi de la acelasi creator'),
  ('fund_min_watch_ms',      3000, 'Watch-time minim (ms) per event ca sa fie calificat pt fond'),
  ('fund_payout_min_cents',  1000, 'Prag minim de payout din fondul creator (cents)')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Atribuire vânzare → clip
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS video_attributions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id         uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  order_id         uuid NOT NULL REFERENCES commerce_orders(id) ON DELETE CASCADE,
  creator_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  buyer_user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  commission_cents integer NOT NULL DEFAULT 0 CHECK (commission_cents >= 0),
  -- cum s-a facut atribuirea: item purtat direct pe order_item vs. fereastra
  -- de 7 zile pe feed_events (view/product_click/add_to_cart)
  attribution_source text NOT NULL DEFAULT 'order_item'
    CHECK (attribution_source IN ('order_item', 'event_window')),
  window_days      integer NOT NULL DEFAULT 7 CHECK (window_days > 0),
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (video_id, order_id)
);

CREATE INDEX IF NOT EXISTS video_attributions_creator_idx
  ON video_attributions (creator_id, created_at DESC);
CREATE INDEX IF NOT EXISTS video_attributions_order_idx
  ON video_attributions (order_id);

-- ---------------------------------------------------------------------------
-- 3. Fond creator lunar
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS creator_fund_pools (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  month          date NOT NULL UNIQUE,           -- prima zi a lunii
  pool_cents     bigint NOT NULL CHECK (pool_cents >= 0),
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'distributed')),
  distributed_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS creator_fund_payouts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_id            uuid NOT NULL REFERENCES creator_fund_pools(id) ON DELETE CASCADE,
  creator_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  qualified_watch_ms bigint NOT NULL DEFAULT 0 CHECK (qualified_watch_ms >= 0),
  share_ratio        numeric(10,8) NOT NULL DEFAULT 0 CHECK (share_ratio >= 0 AND share_ratio <= 1),
  amount_cents       bigint NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
  -- 'paid' => a fost emis in wallet_ledger; 'below_threshold' => sub pragul minim
  status             text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'below_threshold')),
  paid_at            timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pool_id, creator_id)
);

CREATE INDEX IF NOT EXISTS creator_fund_payouts_creator_idx
  ON creator_fund_payouts (creator_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 4. Index pentru agregari zilnice pe creator (plafon vizualizari / saturatie)
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS feed_events_type_video_day_idx
  ON feed_events (event_type, video_id, occurred_at DESC)
  WHERE event_type IN ('video_view', 'impression', 'watch_time', 'purchase', 'add_to_cart');

COMMIT;
