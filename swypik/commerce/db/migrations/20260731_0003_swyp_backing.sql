-- Fondul de acoperire SWYP (backing fund) — valoarea REALĂ a monedei.
--
-- Model economic (decizie owner):
--  * Fondul se alimentează cu un procent (swyp_backing_pct, default 10%) din
--    comisionul NET al platformei, la fiecare decontare reală.
--  * Curs SWYP = backing_fund / SWYP în circulație la utilizatori.
--    Zero tranzacții → fond 0 → curs 0. Cursul crește DOAR din încasări reale.
--  * La plata cu SWYP: subunitățile se întorc în pool-ul 'rewards', iar
--    contravaloarea în RON iese din fond → echilibru contabil permanent.

CREATE TABLE IF NOT EXISTS swyp_backing_fund (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  balance_cents bigint NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  total_in_cents bigint NOT NULL DEFAULT 0,
  total_out_cents bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO swyp_backing_fund (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS swyp_backing_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  direction text NOT NULL CHECK (direction IN ('in','out')),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  ref_type text NOT NULL,
  ref_id text NOT NULL,
  rate_microcents_per_unit numeric,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (direction, ref_type, ref_id)
);
CREATE INDEX IF NOT EXISTS idx_swyp_backing_ledger_created ON swyp_backing_ledger (created_at DESC);

INSERT INTO platform_config (key, value) VALUES ('swyp_backing_pct', '10'::jsonb)
ON CONFLICT (key) DO NOTHING;
