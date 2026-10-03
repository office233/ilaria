-- 20260731_0002_swyp_treasury_ledger.sql
-- Fundația economiei SWYP (Faza 0, off-chain, pregătită pentru migrare on-chain).
--
-- Principii (vezi MASTER_PLAN / plan SWYP):
--   * SUPPLY FIX: 10.000.000.000 SWYP, "mintat" integral la genesis în pool-uri
--     de trezorerie. Nicio funcție de emisie ulterioară. Orice recompensă e un
--     TRANSFER din pool → user, nu creație din neant.
--   * Unitatea de stocare: 1 SWYP = 100 subunități ("cents"), bigint.
--     Total supply = 1.000.000.000.000 subunități (încape lejer în bigint).
--   * Ledger append-only cu hash-chain (prev_hash → entry_hash) pentru audit
--     public și reconciliere la migrarea on-chain.
--   * Idempotență: UNIQUE (ref_type, ref_id, kind) — același contract ca
--     wallet_ledger_entries (bani reali).
--   * Invariant verificabil: SUM(pool.balance) + SUM(user.balance) = supply fix.
--
-- Idempotent: IF NOT EXISTS / ON CONFLICT DO NOTHING peste tot.

-- ── Config globală ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS swyp_config (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO swyp_config (key, value) VALUES
  ('total_supply_units', '1000000000000'::jsonb),          -- 10 mld SWYP × 100
  ('tradable', 'false'::jsonb),                            -- flag SWYP_TRADABLE (F3)
  ('emission_halving_user_thresholds', '[10000, 100000, 1000000, 10000000]'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ── Pool-uri de trezorerie (genesis allocation) ─────────────────────────
CREATE TABLE IF NOT EXISTS swyp_treasury_pools (
  pool           text PRIMARY KEY,          -- rewards | ecosystem | company | team | reserve
  balance_units  bigint NOT NULL CHECK (balance_units >= 0),
  genesis_units  bigint NOT NULL CHECK (genesis_units >= 0),
  -- vesting (doar informativ în F0; aplicat de cod)
  vesting_months int NOT NULL DEFAULT 0,
  cliff_months   int NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Genesis: 55% rewards, 15% ecosystem, 15% company(vest 48/cliff 0),
-- 10% team(vest 48/cliff 12), 5% reserve. Total = exact 1e12 subunități.
INSERT INTO swyp_treasury_pools (pool, balance_units, genesis_units, vesting_months, cliff_months) VALUES
  ('rewards',   550000000000, 550000000000,  0,  0),
  ('ecosystem', 150000000000, 150000000000,  0,  0),
  ('company',   150000000000, 150000000000, 48,  0),
  ('team',      100000000000, 100000000000, 48, 12),
  ('reserve',    50000000000,  50000000000,  0,  0)
ON CONFLICT (pool) DO NOTHING;

-- ── Solduri utilizatori ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS swyp_balances (
  user_id       uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance_units bigint NOT NULL DEFAULT 0 CHECK (balance_units >= 0),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ── Ledger append-only cu hash-chain ────────────────────────────────────
-- O intrare = o mutare de subunități între (pool sau user) → (pool sau user).
-- Exact una dintre coloanele from_* / to_* per parte e non-null.
CREATE TABLE IF NOT EXISTS swyp_ledger_entries (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  from_pool       text REFERENCES swyp_treasury_pools(pool),
  from_user_id    uuid REFERENCES users(id),
  to_pool         text REFERENCES swyp_treasury_pools(pool),
  to_user_id      uuid REFERENCES users(id),
  amount_units    bigint NOT NULL CHECK (amount_units > 0),
  kind            text NOT NULL,            -- reward | spend | purchase | transfer | adjustment
  ref_type        text NOT NULL,
  ref_id          text NOT NULL,
  description     text,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- hash-chain: sha256(prev_hash || id || from || to || amount || ref)
  prev_hash       text NOT NULL,
  entry_hash      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT swyp_ledger_one_from CHECK ((from_pool IS NULL) <> (from_user_id IS NULL)),
  CONSTRAINT swyp_ledger_one_to   CHECK ((to_pool   IS NULL) <> (to_user_id   IS NULL)),
  CONSTRAINT swyp_ledger_idem UNIQUE (ref_type, ref_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_swyp_ledger_to_user   ON swyp_ledger_entries (to_user_id, created_at DESC) WHERE to_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_swyp_ledger_from_user ON swyp_ledger_entries (from_user_id, created_at DESC) WHERE from_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_swyp_ledger_kind      ON swyp_ledger_entries (kind, created_at DESC);

-- ── Reguli de emisie (rate card, în RON-bani → SWYP la cursul intern) ───
CREATE TABLE IF NOT EXISTS swyp_emission_rules (
  action          text PRIMARY KEY,          -- mining_daily | referral_validated | go_ride_completed | eats_delivery_on_time | creator_1k_views | order_review | seller_first_sales | clip_conversion
  amount_units    bigint NOT NULL CHECK (amount_units > 0),
  daily_cap_units bigint,                    -- NULL = fără cap zilnic
  requires_paid_tx boolean NOT NULL DEFAULT false, -- anti-sybil: doar după plată reală
  enabled         boolean NOT NULL DEFAULT true,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

INSERT INTO swyp_emission_rules (action, amount_units, daily_cap_units, requires_paid_tx, enabled) VALUES
  ('mining_daily',            1000,  2000, false, true),   -- 10 SWYP/zi bază (cap = bază×2, acoperă streak +100%)
  ('referral_validated',      5000,  25000, true,  true),  -- 50 SWYP, max 5/zi, DOAR după plata invitatului
  ('go_ride_completed',       2000,  20000, true,  true),  -- 20 SWYP/cursă
  ('eats_delivery_on_time',   1500,  30000, true,  true),
  ('creator_1k_views',        1000,  50000, false, true),
  ('order_review',             500,   1500, true,  true),
  ('clip_conversion',         5000,  50000, true,  true),
  ('seller_first_sales',     10000,  50000, true,  true)
ON CONFLICT (action) DO NOTHING;

-- ── Sesiuni de mining (stil Pi: 24h, streak, halving global) ────────────
CREATE TABLE IF NOT EXISTS swyp_mining_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at    timestamptz NOT NULL DEFAULT now(),
  ends_at       timestamptz NOT NULL,
  claimed_at    timestamptz,
  streak_days   int NOT NULL DEFAULT 1 CHECK (streak_days >= 1),
  rate_units    bigint NOT NULL CHECK (rate_units > 0),   -- rata înghețată la start
  ledger_entry_id bigint REFERENCES swyp_ledger_entries(id)
);
-- o singură sesiune activă per user
CREATE UNIQUE INDEX IF NOT EXISTS idx_swyp_mining_active
  ON swyp_mining_sessions (user_id) WHERE claimed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_swyp_mining_user ON swyp_mining_sessions (user_id, started_at DESC);

-- ── Funcție de verificare a invariantului de supply ─────────────────────
CREATE OR REPLACE FUNCTION swyp_verify_supply() RETURNS bigint AS $$
  -- Returnează diferența față de supply-ul fix (0 = sănătos).
  SELECT (SELECT (value)::text::bigint FROM swyp_config WHERE key = 'total_supply_units')
       - (COALESCE((SELECT SUM(balance_units) FROM swyp_treasury_pools), 0)
        + COALESCE((SELECT SUM(balance_units) FROM swyp_balances), 0));
$$ LANGUAGE sql STABLE;
