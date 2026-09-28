-- Raritate SWYP: emisia se leagă de BANII EFECTIV ÎNCASAȚI, cu plafon lunar.
--
-- Principiu: se emite valoare mai mică decât acoperirea intrată în fond.
-- Diferența = aprecierea monedei. Dacă fondul nu primește (plafon atins,
-- comision zero), NU se emite nimic — moneda nu se diluează niciodată.
--
--   emisie_valoare = fond_alimentat_efectiv × pct_of_funded_bps / 10000
--   pct_of_funded_bps = 4000 → se emit 40% din cât intră; 60% rămâne surplus
--   care ridică cursul pentru toți deținătorii.
--
-- Plafon lunar: costul SWYP devine predictibil ca o factură, nu procent
-- nelimitat din creștere.

ALTER TABLE swyp_emission_rules
  ADD COLUMN IF NOT EXISTS pct_of_funded_bps integer
  CHECK (pct_of_funded_bps IS NULL OR (pct_of_funded_bps > 0 AND pct_of_funded_bps <= 10000));

UPDATE swyp_emission_rules SET pct_of_funded_bps = 4000
 WHERE action IN ('go_ride_completed', 'eats_delivery_on_time');

-- Plafon lunar pentru cât poate primi fondul (cents). 200000 = 2.000 RON/lună.
INSERT INTO platform_config (key, value) VALUES
  ('swyp_backing_monthly_cap_cents', '200000'::jsonb)
ON CONFLICT (key) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_swyp_backing_ledger_month
  ON swyp_backing_ledger (direction, created_at);
