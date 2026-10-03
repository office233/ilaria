-- ============================================================================
-- FRONT R5 — Plăți & payout (Eats + Go)
--   * rides: trasabilitate plată (Stripe PaymentIntent, status plată, tip)
--   * local_orders / rides: marcaj de decontare (settled_at) — idempotență
--   * payout_requests: cereri de retragere din soldul wallet (min 50 RON)
--   * merchant_settlements: partea merchantului la Eats (sellers nu au wallet
--     de user, deci se decontează separat, manual/agregat)
--   * reconciliation_issues: probleme găsite de cron-ul de reconciliere
-- Idempotent.
-- ============================================================================

BEGIN;

-- ── 0. wallet: permite sold negativ (datoria de comision la încasările cash) ──
--   Curierul care încasează cash are fizic toți banii; platforma îi reține
--   comisionul (și, la Eats, partea merchantului) ca DEBIT — soldul poate
--   coborî sub zero. Payout-ul rămâne permis doar din sold pozitiv.
ALTER TABLE wallet_balances DROP CONSTRAINT IF EXISTS wallet_balances_balance_cents_check;
ALTER TABLE wallet_ledger_entries DROP CONSTRAINT IF EXISTS wallet_ledger_entries_balance_after_cents_check;

ALTER TABLE rides
  ADD COLUMN IF NOT EXISTS payment_intent_id text,
  ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT 'unpaid',
  ADD COLUMN IF NOT EXISTS tip_cents integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS settled_at timestamptz;

-- R4 a creat payment_status cu CHECK ('pending','paid','refunded','failed')
-- și default 'pending'. R5 folosește stări mai granulare — remapăm.
ALTER TABLE rides DROP CONSTRAINT IF EXISTS rides_payment_status_check;
UPDATE rides SET payment_status = CASE payment_status
    WHEN 'pending' THEN 'unpaid'
    WHEN 'paid' THEN 'captured'
    ELSE payment_status END
  WHERE payment_status IN ('pending', 'paid');
ALTER TABLE rides ALTER COLUMN payment_status SET DEFAULT 'unpaid';

DO $$ BEGIN
  ALTER TABLE rides ADD CONSTRAINT rides_payment_status_chk CHECK
    (payment_status IN ('unpaid','authorized','captured','collected_cash','failed','refunded'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 2. local_orders: marcaj decontare ───────────────────────────────────────
ALTER TABLE local_orders
  ADD COLUMN IF NOT EXISTS settled_at timestamptz,
  ADD COLUMN IF NOT EXISTS tip_cents integer NOT NULL DEFAULT 0;

-- ── 3. payout_requests ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payout_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  currency char(3) NOT NULL DEFAULT 'RON',
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','paid','rejected')),
  iban text,
  note text,
  admin_note text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by text
);

CREATE INDEX IF NOT EXISTS idx_payout_requests_user
  ON payout_requests (user_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_payout_requests_status
  ON payout_requests (status, requested_at) WHERE status = 'pending';

-- ── 4. merchant_settlements (partea merchantului la Eats) ───────────────────
CREATE TABLE IF NOT EXISTS merchant_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES local_merchants(id) ON DELETE CASCADE,
  order_id uuid NOT NULL UNIQUE REFERENCES local_orders(id) ON DELETE CASCADE,
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  -- 'cash_with_courier': banii au fost încasați cash de curier; merchantul
  -- e plătit din datoria curierului. 'platform_owes': plată card → platforma
  -- îi datorează merchantului suma.
  source text NOT NULL CHECK (source IN ('cash_with_courier','platform_owes')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid')),
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_merchant_settlements_merchant
  ON merchant_settlements (merchant_id, status);

-- ── 5. reconciliation_issues ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reconciliation_issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,           -- 'balance_mismatch' | 'unsettled_ride' | 'unsettled_order'
  ref_id text NOT NULL,         -- user_id / ride_id / order_id
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolved boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz
);

  -- aceeași problemă nu se raportează de două ori cât e nerezolvată
  CREATE UNIQUE INDEX IF NOT EXISTS reconciliation_issue_open_unique
    ON reconciliation_issues (kind, ref_id) WHERE resolved = false;

COMMIT;
