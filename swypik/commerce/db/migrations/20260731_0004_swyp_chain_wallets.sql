-- 20260731_0004_swyp_chain_wallets.sql
-- Portofel on-chain (Swypik Chain, chainId 643366) pentru fiecare utilizator.
-- Custodial în faza 0-2: cheia privată e criptată AES-256-GCM cu cheia
-- aplicației; userul își poate EXPORTA cheia oricând (proprietate reală),
-- iar la export marcăm exported_at (după export, custodia e partajată).
-- Idempotent.

CREATE TABLE IF NOT EXISTS swyp_chain_wallets (
  user_id       uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  address       text NOT NULL UNIQUE,          -- 0x..., checksum
  enc_privkey   text NOT NULL,                 -- iv:tag:cipher (base64), AES-256-GCM
  created_at    timestamptz NOT NULL DEFAULT now(),
  exported_at   timestamptz                    -- prima dată când userul și-a văzut cheia
);

CREATE INDEX IF NOT EXISTS idx_swyp_chain_wallets_addr ON swyp_chain_wallets (address);
