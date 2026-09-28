-- 20260730_0002_wallet_ledger_cents.sql
-- Ledger monetar dedicat, în CENȚI (bani reali — separat de punctele
-- swyp_wallets/wallet_transactions și de gamificarea user_wallets/wallet_ledger).
--
-- Reguli:
--  * append-only: intrările nu se modifică/șterg niciodată;
--  * idempotență pe (ref_type, ref_id, kind) — un eveniment de business
--    creditează/debitează o singură dată;
--  * balance_after_cents e denormalizat pentru audit rapid; sursa de
--    adevăr pentru sold e wallet_balances.balance_cents, actualizat în
--    aceeași tranzacție cu SELECT ... FOR UPDATE (vezi lib/wallet/ledger.ts).

BEGIN;

CREATE TABLE IF NOT EXISTS wallet_balances (
  user_id       uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance_cents bigint NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  currency      text NOT NULL DEFAULT 'RON',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wallet_ledger_entries (
  id                  bigserial PRIMARY KEY,
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind                text NOT NULL CHECK (kind IN ('credit', 'debit')),
  amount_cents        bigint NOT NULL CHECK (amount_cents > 0),
  balance_after_cents bigint NOT NULL CHECK (balance_after_cents >= 0),
  -- referința evenimentului de business (ordine, payout, refund, bonus...)
  ref_type            text NOT NULL,
  ref_id              text NOT NULL,
  description         text,
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- idempotență: același eveniment nu poate credita/debita de două ori
  CONSTRAINT wallet_ledger_entries_ref_unique UNIQUE (ref_type, ref_id, kind)
);

CREATE INDEX IF NOT EXISTS wallet_ledger_entries_user_idx
  ON wallet_ledger_entries (user_id, created_at DESC);

COMMIT;
