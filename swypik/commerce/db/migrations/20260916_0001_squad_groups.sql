-- Migration: Squad Buy (Group Buying viral)
-- Creează tabelele pentru grupuri de cumpărături cu discount de echipă (stil Pinduoduo).

CREATE TABLE IF NOT EXISTS squad_groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL REFERENCES marketplace_products(id) ON DELETE CASCADE,
    creator_user_id UUID,
    creator_name VARCHAR(100) DEFAULT 'Cumpărător Swypik',
    creator_avatar VARCHAR(500),
    required_members INT NOT NULL DEFAULT 2,
    current_members INT NOT NULL DEFAULT 1,
    squad_price_cents INT NOT NULL,
    regular_price_cents INT NOT NULL,
    currency VARCHAR(10) NOT NULL DEFAULT 'RON',
    status VARCHAR(32) NOT NULL DEFAULT 'active',
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '24 hours'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS squad_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    squad_id UUID NOT NULL REFERENCES squad_groups(id) ON DELETE CASCADE,
    user_id UUID,
    user_name VARCHAR(100) NOT NULL DEFAULT 'Membru Squad',
    user_avatar VARCHAR(500),
    order_id UUID,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    status VARCHAR(32) NOT NULL DEFAULT 'confirmed'
);

CREATE INDEX IF NOT EXISTS idx_squad_groups_product ON squad_groups(product_id);
CREATE INDEX IF NOT EXISTS idx_squad_groups_status ON squad_groups(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_squad_members_squad ON squad_members(squad_id);
