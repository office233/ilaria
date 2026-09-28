-- Swypik Fly — price watch competitori.
-- Stocăm zilnic: prețul nostru (Duffel+markup, RON) vs. cel mai mic preț
-- văzut în piață (Travelpayouts Data API — DOAR sursă de date, zero linkuri
-- către competitori). Raport: unde suntem bătuți și cu cât.

CREATE TABLE IF NOT EXISTS fly_price_watch (
    id BIGSERIAL PRIMARY KEY,
    origin TEXT NOT NULL,
    destination TEXT NOT NULL,
    depart_date DATE NOT NULL,
    our_total_cents INTEGER,            -- prețul nostru final în bani (RON)
    market_min_cents INTEGER,           -- cel mai mic preț din piață (RON)
    market_source TEXT,                 -- ex: 'travelpayouts'
    market_airline TEXT,
    delta_cents INTEGER,                -- our - market (negativ = suntem mai ieftini)
    checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fly_price_watch_route
    ON fly_price_watch (origin, destination, depart_date, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_fly_price_watch_checked
    ON fly_price_watch (checked_at DESC);
