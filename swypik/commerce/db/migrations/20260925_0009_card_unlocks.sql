-- Movies & Music unlocks: card payment via Stripe (RON), replacing SWYP.
-- Additive only — no drops, no data conversion. Existing SWYP-era unlock rows
-- keep granting access (status defaults to 'paid'); new price columns start
-- NULL ("price coming soon") until a creator/artist sets a RON price.

ALTER TABLE movie_series
    ADD COLUMN IF NOT EXISTS episode_price_cents bigint CHECK (episode_price_cents IS NULL OR episode_price_cents > 0);

ALTER TABLE movie_unlocks
    ADD COLUMN IF NOT EXISTS payment_intent_id text UNIQUE,
    ADD COLUMN IF NOT EXISTS amount_cents bigint,
    ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'RON',
    ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'paid' CHECK (status IN ('pending', 'paid', 'failed', 'refunded'));

ALTER TABLE music_tracks
    ADD COLUMN IF NOT EXISTS price_cents bigint CHECK (price_cents IS NULL OR price_cents > 0);

ALTER TABLE music_albums
    ADD COLUMN IF NOT EXISTS price_cents bigint CHECK (price_cents IS NULL OR price_cents > 0);

ALTER TABLE music_unlocks
    ADD COLUMN IF NOT EXISTS payment_intent_id text UNIQUE,
    ADD COLUMN IF NOT EXISTS amount_cents bigint,
    ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'RON',
    ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'paid' CHECK (status IN ('pending', 'paid', 'failed', 'refunded'));
