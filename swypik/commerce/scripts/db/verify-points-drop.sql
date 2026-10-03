-- Verificare post-migrare 20260731_0001_drop_points_systems
\echo '=== Tabele wallet/reward/challenge ramase (asteptat: doar wallet_balances, wallet_ledger_entries) ==='
SELECT tablename FROM pg_tables
WHERE schemaname = 'public'
  AND (tablename LIKE '%wallet%' OR tablename LIKE '%reward%'
       OR tablename LIKE '%challenge%' OR tablename LIKE '%mission%'
       OR tablename LIKE '%streak%' OR tablename LIKE '%milestone%')
ORDER BY 1;

\echo '=== Functii wallet_apply ramase (asteptat: 0 randuri) ==='
SELECT p.proname FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname IN ('wallet_apply', 'reward_events_credit_wallet');

\echo '=== Coloane swyp pe users (asteptat: 0 randuri) ==='
SELECT column_name FROM information_schema.columns
WHERE table_name = 'users' AND column_name LIKE '%swyp%';

\echo '=== Bani reali intacti (asteptat: 2 tabele + numar randuri) ==='
SELECT 'wallet_balances' AS t, count(*) FROM wallet_balances
UNION ALL
SELECT 'wallet_ledger_entries', count(*) FROM wallet_ledger_entries;
