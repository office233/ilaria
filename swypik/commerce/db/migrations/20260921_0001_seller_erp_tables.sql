-- Migration: tabelele modulului Seller ERP (clienți, facturi, campanii ads, bonuri POS)
--
-- Rutele /api/seller/{clients,invoices,ads,pos/sale} au fost livrate pe 16 sept
-- 2026 FĂRĂ nicio migrare: interogau tabele inexistente și dădeau 500 în
-- producție. Aici sunt definite din interogările efective ale acelor rute.
--
-- seller_sequences: contor atomic per (seller, tip, serie) pentru numerotarea
-- facturilor și a bonurilor. Înlocuiește tiparul `SELECT MAX(number)+1`, care
-- sub concurență emitea două facturi cu același număr.

CREATE TABLE IF NOT EXISTS seller_sequences (
    seller_id  uuid NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
    kind       text NOT NULL,
    series     text NOT NULL DEFAULT '',
    value      integer NOT NULL DEFAULT 0 CHECK (value >= 0),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (seller_id, kind, series)
);

CREATE TABLE IF NOT EXISTS seller_clients (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seller_id  uuid NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
    name       text NOT NULL,
    cui        text,
    reg_com    text,
    phone      text,
    email      text,
    address    text,
    city       text,
    county     text,
    notes      text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_seller_clients_seller_name ON seller_clients (seller_id, name);

CREATE TABLE IF NOT EXISTS seller_invoices (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seller_id       uuid NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
    client_id       uuid REFERENCES seller_clients(id) ON DELETE SET NULL,
    series          text NOT NULL,
    number          integer NOT NULL CHECK (number > 0),
    invoice_number  text NOT NULL,
    client_name     text NOT NULL,
    client_cui      text,
    client_address  text,
    items           jsonb NOT NULL DEFAULT '[]'::jsonb,
    currency        text NOT NULL DEFAULT 'RON',
    vat_rate_pct    numeric(5,2) NOT NULL,
    subtotal_cents  bigint NOT NULL CHECK (subtotal_cents >= 0),
    vat_cents       bigint NOT NULL CHECK (vat_cents >= 0),
    total_cents     bigint NOT NULL CHECK (total_cents >= 0),
    status          text NOT NULL DEFAULT 'issued'
                    CHECK (status IN ('draft', 'issued', 'paid', 'cancelled')),
    -- e-Factura (ANAF SPV): 'not_sent' până există o integrare reală de transmitere.
    efactura_status text NOT NULL DEFAULT 'not_sent'
                    CHECK (efactura_status IN ('not_sent', 'pending', 'sent', 'accepted', 'rejected')),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (seller_id, series, number)
);
CREATE INDEX IF NOT EXISTS idx_seller_invoices_seller_created ON seller_invoices (seller_id, created_at DESC);

CREATE TABLE IF NOT EXISTS seller_ads (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seller_id          uuid NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
    campaign_name      text NOT NULL,
    ad_type            text NOT NULL DEFAULT 'boost_reel',
    product_id         uuid REFERENCES marketplace_products(id) ON DELETE SET NULL,
    daily_budget_cents integer NOT NULL CHECK (daily_budget_cents > 0),
    spent_budget_cents integer NOT NULL DEFAULT 0 CHECK (spent_budget_cents >= 0),
    target_city        text NOT NULL DEFAULT 'all_ro',
    -- Nu există încă un motor de livrare a reclamelor: o campanie nou creată
    -- așteaptă ('pending_review'), nu pretinde că rulează.
    status             text NOT NULL DEFAULT 'pending_review'
                       CHECK (status IN ('pending_review', 'active', 'paused', 'ended')),
    impressions_count  bigint NOT NULL DEFAULT 0,
    clicks_count       bigint NOT NULL DEFAULT 0,
    orders_count       integer NOT NULL DEFAULT 0,
    revenue_cents      bigint NOT NULL DEFAULT 0,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_seller_ads_seller_created ON seller_ads (seller_id, created_at DESC);

CREATE TABLE IF NOT EXISTS seller_pos_sales (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seller_id      uuid NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
    receipt_number text NOT NULL,
    items          jsonb NOT NULL,
    total_cents    bigint NOT NULL CHECK (total_cents >= 0),
    currency       text NOT NULL DEFAULT 'RON',
    payment_method text NOT NULL CHECK (payment_method IN ('cash', 'card')),
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (seller_id, receipt_number)
);
CREATE INDEX IF NOT EXISTS idx_seller_pos_sales_seller_created ON seller_pos_sales (seller_id, created_at DESC);
