-- 20260731_0006_swyp_reserve_config.sql
-- Configurare rezerva anti-bank-run pentru redeem-urile SWYP.
-- swyp_redeem_reserve_pct: procentul din fondul de la începutul lunii care
--   NU poate fi răscumpărat în luna respectivă (implicit 20%).
--   Ex: fond la 1 ale lunii = 10.000 RON → maxim 8.000 RON redeem-uri/lună.
-- Idempotent.

INSERT INTO platform_config (key, value)
VALUES ('swyp_redeem_reserve_pct', '20'::jsonb)
ON CONFLICT (key) DO NOTHING;
