-- 20260731_0007_swyp_staking.sql
-- Staking SWYP: blochezi X SWYP pe o perioadă → bonus la scadență.
--
-- REGULI (din analiza tokenomics 2026-07-31):
--  * Bonusul se plătește DOAR din bugetul de surplus: 30% din partea
--    ne-emisă a alimentărilor fondului din luna respectivă
--    (0,3 × (1−β) × intrări_fond). Dacă bugetul e consumat, bonusul se
--    reduce pro-rata — NU se emite peste surplus (altfel cursul ar scădea).
--  * SWYP-ul stacat IESE din circulația liberă → cursul-podea crește
--    pentru toți (staked exclus din C în formula P = F/C).
--  * Retragere anticipată: fără bonus, principal integral (fără penalizări
--    ascunse — MiCA-safe, nu e instrument financiar cu risc de pierdere).
--  * APY nominal pe paliere: 3 luni = 8%, 6 luni = 12%, 12 luni = 18%
--    (anualizat), cu clamp automat la buget. Configurabil per palier.
-- Idempotent.

CREATE TABLE IF NOT EXISTS swyp_stakes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_units   bigint NOT NULL CHECK (amount_units > 0),
  term_months    int NOT NULL CHECK (term_months IN (3, 6, 12)),
  apy_bps        int NOT NULL CHECK (apy_bps >= 0),          -- înghețat la creare
  started_at     timestamptz NOT NULL DEFAULT now(),
  matures_at     timestamptz NOT NULL,
  status         text NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'matured', 'withdrawn_early')),
  closed_at      timestamptz,
  bonus_units    bigint,                                      -- plătit la scadență
  ledger_lock_id bigint,                                      -- intrarea de blocare
  ledger_paid_id bigint                                       -- intrarea de plată
);

CREATE INDEX IF NOT EXISTS idx_swyp_stakes_user ON swyp_stakes (user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_swyp_stakes_active ON swyp_stakes (status, matures_at)
  WHERE status = 'active';

-- Pool virtual de staking: SWYP-ul stacat se mută user → pool 'staking',
-- ca să fie exclus automat din circulația liberă (swyp_balances).
INSERT INTO swyp_treasury_pools (pool, balance_units, genesis_units, vesting_months, cliff_months)
VALUES ('staking', 0, 0, 0, 0)
ON CONFLICT (pool) DO NOTHING;

-- Configurare paliere APY (bps) + cota din surplus alocată bonusurilor.
INSERT INTO platform_config (key, value) VALUES
  ('swyp_staking_apy_bps', '{"3": 800, "6": 1200, "12": 1800}'::jsonb),
  ('swyp_staking_surplus_share_bps', '3000'::jsonb)   -- 30% din surplusul lunar
ON CONFLICT (key) DO NOTHING;
