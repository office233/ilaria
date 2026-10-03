-- P1.2: regulă de emisie pentru premiile misiunilor (plătite manual din admin
-- după review). Fără regulă, awardSwyp('mission_prize') dă rule_missing.
INSERT INTO swyp_emission_rules (action, amount_units, daily_cap_units, requires_paid_tx, enabled)
VALUES ('mission_prize', 5000, 100000, false, true)
ON CONFLICT (action) DO NOTHING;
