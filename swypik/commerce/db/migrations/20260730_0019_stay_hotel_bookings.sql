-- Swypik Stays (hoteluri via Duffel Stays) — rezervări.
-- NOTĂ: tabela `stay_bookings` există deja pentru cazările host-urilor proprii
-- (model Airbnb); hotelurile externe au tabelă separată: stay_hotel_bookings.
CREATE TABLE IF NOT EXISTS stay_hotel_bookings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    provider TEXT NOT NULL DEFAULT 'duffel',
    status TEXT NOT NULL DEFAULT 'pending', -- pending|paid|booked|failed|refunded|cancelled
    accommodation_name TEXT NOT NULL,
    check_in DATE NOT NULL,
    check_out DATE NOT NULL,
    guests JSONB NOT NULL DEFAULT '[]',
    quote_snapshot JSONB,
    provider_booking_id TEXT,
    confirmation_code TEXT,
    provider_total_cents INTEGER NOT NULL,
    provider_currency TEXT NOT NULL DEFAULT 'EUR',
    markup_cents INTEGER NOT NULL DEFAULT 0,
    total_cents INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'RON',
    payment_method TEXT NOT NULL DEFAULT 'wallet', -- wallet|stripe
    payment_ref TEXT,
    contact_email TEXT,
    contact_phone TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stay_hotel_bookings_user ON stay_hotel_bookings (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stay_hotel_bookings_status ON stay_hotel_bookings (status) WHERE status IN ('pending','paid');
