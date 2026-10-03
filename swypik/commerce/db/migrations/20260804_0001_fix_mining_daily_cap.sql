-- Bug: daily_cap_units pentru mining_daily era egal cu suma de bază (1000),
-- deci orice user cu streak ≥ 2 zile (rată 1100+) nu putea revendica niciodată
-- (SwypDailyCapError la claim). Capul corect = bază × 2 (streak max +100%).
UPDATE swyp_emission_rules
   SET daily_cap_units = amount_units * 2, updated_at = now()
 WHERE action = 'mining_daily'
   AND daily_cap_units IS NOT NULL
   AND daily_cap_units < amount_units * 2;
