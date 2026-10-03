-- 20260519_0012_reward_events_wallet_trigger.sql
-- ISTORIC: trigger pentru sistemul vechi de puncte (reward_events/swyp_wallets).
-- Sistemul a fost ELIMINAT integral (20260731_0001_drop_points_systems.sql).
-- Migrarea ramane doar pentru bazele istorice care inca au tabelele; pe bazele
-- curente e no-op, ca deploy-ul (care ruleaza toate migrarile) sa nu pice.

DO $$
BEGIN
  IF to_regclass('public.reward_events') IS NULL
     OR to_regclass('public.swyp_wallets') IS NULL THEN
    RETURN; -- tabelele nu mai exista: nimic de facut
  END IF;

  CREATE OR REPLACE FUNCTION fn_reward_events_credit_wallet()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  AS $fn$
  BEGIN
    IF NEW.points_awarded IS NULL OR NEW.points_awarded <= 0 THEN
      RETURN NEW;
    END IF;

    INSERT INTO swyp_wallets (user_id, balance_points, lifetime_earned)
    VALUES (NEW.user_id, NEW.points_awarded, NEW.points_awarded)
    ON CONFLICT (user_id) DO UPDATE
      SET balance_points  = swyp_wallets.balance_points  + EXCLUDED.balance_points,
          lifetime_earned = swyp_wallets.lifetime_earned + EXCLUDED.lifetime_earned,
          updated_at      = now();

    RETURN NEW;
  END;
  $fn$;

  DROP TRIGGER IF EXISTS trg_reward_events_credit_wallet ON reward_events;
  CREATE TRIGGER trg_reward_events_credit_wallet
  AFTER INSERT ON reward_events
  FOR EACH ROW
  EXECUTE FUNCTION fn_reward_events_credit_wallet();
END $$;

INSERT INTO schema_migrations (version, applied_at)
VALUES ('20260519_0012_reward_events_wallet_trigger', now())
ON CONFLICT DO NOTHING;
