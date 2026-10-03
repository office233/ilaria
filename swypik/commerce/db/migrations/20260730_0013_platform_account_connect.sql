-- ============================================================================
-- FRONT R5 (partea 2) — contul de platformă, Stripe Connect pentru curieri,
-- PaymentIntent pe comenzile Eats, extinderea payout_requests pentru
-- transferuri Stripe automate.
-- Idempotent.
-- ============================================================================

BEGIN;

-- ── 1. Utilizator tehnic "platformă" ────────────────────────────────────────
-- Comisioanele platformei se scriu în wallet_ledger_entries pe acest cont;
-- de aici iese raportul GMV / venituri. Id determinist ca să nu depindem de
-- o rulare de seed; poate fi suprascris prin env PLATFORM_USER_ID.
INSERT INTO users (id, username, display_name, role, status, metadata)
VALUES (
  '00000000-0000-0000-0000-00000000f1a7',
  'swypik_platform',
  'Swypik Platform (system)',
  'admin',
  'active',
  '{"system": true, "purpose": "platform commission ledger account"}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO wallet_balances (user_id)
VALUES ('00000000-0000-0000-0000-00000000f1a7')
ON CONFLICT (user_id) DO NOTHING;

-- ── 2. Stripe Connect pentru curieri/șoferi ─────────────────────────────────
-- users.stripe_connect_account_id există deja (selleri marketplace) și e
-- refolosit; pe couriers ținem o copie pentru interogări rapide în payout.
ALTER TABLE couriers
  ADD COLUMN IF NOT EXISTS stripe_account_id text,
  ADD COLUMN IF NOT EXISTS stripe_payouts_enabled boolean NOT NULL DEFAULT false;

-- ── 3. Eats: PaymentIntent pe comandă ───────────────────────────────────────
ALTER TABLE local_orders
  ADD COLUMN IF NOT EXISTS payment_intent_id text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_local_orders_pi
  ON local_orders (payment_intent_id) WHERE payment_intent_id IS NOT NULL;

-- ── 4. payout_requests: transferuri Stripe ──────────────────────────────────
ALTER TABLE payout_requests
  ADD COLUMN IF NOT EXISTS courier_id uuid REFERENCES couriers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS stripe_transfer_id text,
  ADD COLUMN IF NOT EXISTS failure_reason text,
  ADD COLUMN IF NOT EXISTS paid_at timestamptz;

-- statusurile din spec: pending | processing | paid | failed (+ 'rejected'
-- păstrat pentru compatibilitate cu aprobarea manuală din admin).
ALTER TABLE payout_requests DROP CONSTRAINT IF EXISTS payout_requests_status_check;
DO $$ BEGIN
  ALTER TABLE payout_requests ADD CONSTRAINT payout_requests_status_chk CHECK
    (status IN ('pending', 'processing', 'paid', 'failed', 'rejected'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payout_requests_transfer
  ON payout_requests (stripe_transfer_id) WHERE stripe_transfer_id IS NOT NULL;

COMMIT;
