-- 20260924_0004_crypto_transactions.sql
-- Swypik Non-Custodial Web3 Crypto DEX Swaps & Market Watchlist

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Istoric tranzacții crypto non-custodial
CREATE TABLE IF NOT EXISTS crypto_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    wallet_address TEXT NOT NULL,
    chain_id TEXT NOT NULL, -- '1' (ETH), '137' (Polygon), '42161' (Arbitrum), '56' (BSC), 'solana'
    tx_hash TEXT NOT NULL UNIQUE,
    aggregator TEXT NOT NULL, -- '0x', '1inch', 'jupiter'
    from_token_symbol TEXT NOT NULL,
    from_token_address TEXT NOT NULL,
    from_amount NUMERIC(36, 18) NOT NULL,
    to_token_symbol TEXT NOT NULL,
    to_token_address TEXT NOT NULL,
    to_amount NUMERIC(36, 18) NOT NULL,
    gas_fee_usd NUMERIC(10, 4),
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'confirmed', 'failed'
    explorer_url TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    confirmed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_crypto_tx_user ON crypto_transactions (user_id);
CREATE INDEX IF NOT EXISTS idx_crypto_tx_wallet ON crypto_transactions (wallet_address);
CREATE INDEX IF NOT EXISTS idx_crypto_tx_hash ON crypto_transactions (tx_hash);

-- 2. Monede Favorite / Watchlist
CREATE TABLE IF NOT EXISTS crypto_user_favorites (
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    coin_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, coin_id)
);

COMMIT;
