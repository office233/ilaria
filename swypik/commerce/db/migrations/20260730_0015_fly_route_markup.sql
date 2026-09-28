-- Swypik Fly — repricing automat per rută.
-- Când piața ne bate pe o rută, cron-ul scrie aici o marjă redusă (în bani
-- RON). searchFlights() o aplică în locul marjei standard. Fără rând = marja
-- standard (FLY_MARKUP_CENTS). Marja nu coboară sub FLY_MARKUP_MIN_CENTS.

CREATE TABLE IF NOT EXISTS fly_route_markup (
    origin TEXT NOT NULL,
    destination TEXT NOT NULL,
    markup_ron_cents INTEGER NOT NULL,   -- marja aplicată, în bani RON
    reason TEXT,                          -- ex: 'beaten_by_market:travelpayouts'
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (origin, destination)
);
