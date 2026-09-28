-- Migration: Mystery Drop — revendicări zilnice persistate server-side
--
-- Versiunea din 16 sept 2026 primea data ultimei revendicări DIN CLIENT
-- (`lastClaimedAt` în body) și nu scria nimic: oricine putea „deschide cutia"
-- de oricâte ori, iar premiul afișat nu era creditat nicăieri.
--
-- Acum: un rând pe (user, zi) — UNIQUE face revendicarea idempotentă —, iar
-- singurul tip de premiu care se acordă efectiv este SWYP, prin
-- swyp_emission_rules ('mystery_drop_daily'), configurabil din DB.

CREATE TABLE IF NOT EXISTS mystery_drop_claims (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    claim_date  date NOT NULL,
    reward_id   text NOT NULL,
    swyp_units  bigint NOT NULL DEFAULT 0 CHECK (swyp_units >= 0),
    ledger_ref  text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, claim_date)
);

INSERT INTO swyp_emission_rules (action, amount_units, daily_cap_units, requires_paid_tx, enabled)
VALUES ('mystery_drop_daily', 1000, 2500, false, true)
ON CONFLICT (action) DO NOTHING;
