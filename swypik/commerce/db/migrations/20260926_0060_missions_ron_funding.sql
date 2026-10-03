-- 20260926_0060_missions_ron_funding
--
-- Misiunile creatorilor: premii DOAR în RON, finanțate înainte de activare.
--   * seller   → plătește fondul de premii cu cardul (Stripe PaymentIntent,
--                metadata.kind = 'mission_funding'); webhook-ul marchează
--                funding_status = 'funded' și activează misiunea;
--   * platform → misiuni create din admin, finanțate de Swypik.
-- Escrow-ul se urmărește pe rândul misiunii: funded_cents (încasat),
-- paid_out_cents (premii creditate în portofelul RON al câștigătorilor),
-- refunded_cents (rest returnat sellerului la închidere).
-- Invariant: paid_out_cents + refunded_cents <= funded_cents.
--
-- SWYP (crypto, eliminat 2026-09-25): misiunile vechi în altă monedă se
-- arhivează; moneda/suma originală rămân în metadata.legacy_prize_*.
-- Idempotent; nimic nu se șterge.

BEGIN;

-- 1. Arhivează misiunile non-RON înainte de a restrânge CHECK-ul.
UPDATE creator_missions
   SET metadata = metadata || jsonb_build_object(
         'legacy_prize_currency', prize_currency,
         'legacy_prize_amount_minor', prize_amount_minor),
       status = 'archived',
       prize_currency = 'RON',
       prize_amount_minor = 0
 WHERE prize_currency <> 'RON';

ALTER TABLE creator_missions ALTER COLUMN prize_currency SET DEFAULT 'RON';
ALTER TABLE creator_missions DROP CONSTRAINT IF EXISTS creator_missions_prize_currency_check;
DO $$ BEGIN
  ALTER TABLE creator_missions ADD CONSTRAINT creator_missions_prize_currency_check
    CHECK (prize_currency = 'RON');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE creator_mission_submissions ALTER COLUMN payout_currency SET DEFAULT 'RON';
UPDATE creator_mission_submissions
   SET payout_currency = 'RON'
 WHERE payout_currency <> 'RON' AND payout_minor = 0;

-- 2. Finanțare / escrow.
ALTER TABLE creator_missions
  ADD COLUMN IF NOT EXISTS created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS funding_source text NOT NULL DEFAULT 'seller',
  ADD COLUMN IF NOT EXISTS funding_status text NOT NULL DEFAULT 'unfunded',
  ADD COLUMN IF NOT EXISTS funded_cents bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS paid_out_cents bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refunded_cents bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS funding_payment_intent_id text,
  ADD COLUMN IF NOT EXISTS funded_at timestamptz,
  ADD COLUMN IF NOT EXISTS closed_at timestamptz;

DO $$ BEGIN
  ALTER TABLE creator_missions ADD CONSTRAINT creator_missions_funding_source_check
    CHECK (funding_source IN ('seller', 'platform'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE creator_missions ADD CONSTRAINT creator_missions_funding_status_check
    CHECK (funding_status IN ('unfunded', 'pending', 'funded', 'refunded'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE creator_missions ADD CONSTRAINT creator_missions_escrow_check
    CHECK (funded_cents >= 0 AND paid_out_cents >= 0 AND refunded_cents >= 0
           AND paid_out_cents + refunded_cents <= funded_cents);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_missions_funding_pi
  ON creator_missions (funding_payment_intent_id)
  WHERE funding_payment_intent_id IS NOT NULL;

-- Misiunile active existente fără finanțare nu mai apar public până nu sunt
-- finanțate (lista publică cere funding_status = 'funded').

COMMIT;
