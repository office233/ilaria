-- Emisie SWYP proporțională cu valoarea tranzacției — ZERO hardcodări.
--
--  pct_of_value_bps (basis points, 100 bps = 1%):
--   * NULL  → regula plătește suma fixă amount_units (comportamentul vechi);
--   * setat → cashback = (valoare_tranzacție × bps/10000) convertit în SWYP la
--             cursul curent. BOOTSTRAP: cât timp cursul e 0 (fond gol), se
--             folosește amount_units fix — altfel împărțirea la 0 ar bloca
--             emisia înainte de prima încasare reală.
--
-- Calibrare (analiza 2026-07-31): fond 10% din comision ≈ 2,4% din tarif;
-- emisie 2,0% rides / 1,5% eats → presiune ușor pozitivă pe curs (intră mai
-- multă acoperire decât valoare emisă). Toate valorile editabile din DB.

ALTER TABLE swyp_emission_rules
  ADD COLUMN IF NOT EXISTS pct_of_value_bps integer
  CHECK (pct_of_value_bps IS NULL OR (pct_of_value_bps > 0 AND pct_of_value_bps <= 2000));

UPDATE swyp_emission_rules SET pct_of_value_bps = 200 WHERE action = 'go_ride_completed';
UPDATE swyp_emission_rules SET pct_of_value_bps = 150 WHERE action = 'eats_delivery_on_time';
