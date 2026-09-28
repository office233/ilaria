-- Swypik Fly — rezervări zboruri (Duffel + Kiwi Tequila, adapter comun).
-- Prețul stocat în cenți; provider_total_cents = cost la furnizor,
-- total_cents = ce plătește clientul (cost + FLY_MARKUP_CENTS).

CREATE TABLE IF NOT EXISTS flight_bookings (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL REFERENCES users(id),
    provider        text NOT NULL CHECK (provider IN ('duffel','kiwi')),
    provider_offer_id  text NOT NULL,
    provider_order_id  text,
    booking_ref     text,                      -- PNR / cod rezervare
    status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','paid','ticketed','failed','cancelled')),
    origin          text NOT NULL,             -- IATA
    destination     text NOT NULL,             -- IATA
    depart_date     date NOT NULL,
    return_date     date,
    passengers      jsonb NOT NULL DEFAULT '[]'::jsonb,
    offer_snapshot  jsonb NOT NULL DEFAULT '{}'::jsonb,
    provider_total_cents bigint NOT NULL,
    markup_cents    bigint NOT NULL DEFAULT 0,
    total_cents     bigint NOT NULL,
    currency        text NOT NULL DEFAULT 'EUR',
    payment_method  text CHECK (payment_method IN ('wallet','stripe')),
    payment_ref     text,                      -- ledger entry id / stripe session id
    error_message   text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_flight_bookings_user ON flight_bookings (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_flight_bookings_status ON flight_bookings (status) WHERE status IN ('pending','paid');
CREATE UNIQUE INDEX IF NOT EXISTS uq_flight_bookings_provider_order
    ON flight_bookings (provider, provider_order_id) WHERE provider_order_id IS NOT NULL;
