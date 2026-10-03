-- Migration: plăți de deblocare Movies/Music — o singură procesare per PaymentIntent.
--
-- Cursa: un user poate plăti de două ori aceeași deblocare (două tab-uri, retry
-- după schimbarea prețului → două PaymentIntent-uri pe același rând). Webhook-ul
-- marca doar primul; al doilea rămânea încasat fără efect. Tabela de mai jos
-- are cheia primară pe payment_intent_id: fiecare plată e procesată exact o dată
-- (retry-urile Stripe devin no-op), iar plata duplicată e rambursată automat și
-- înregistrată cu rezultatul ei. Aditivă și idempotentă.

CREATE TABLE IF NOT EXISTS media_unlock_payments (
    payment_intent_id text PRIMARY KEY,
    vertical          text NOT NULL CHECK (vertical IN ('movies', 'music')),
    unlock_id         text,
    amount_cents      bigint NOT NULL CHECK (amount_cents >= 0),
    outcome           text NOT NULL DEFAULT 'processing'
                      CHECK (outcome IN ('processing', 'granted', 'duplicate_refunded', 'duplicate_refund_failed', 'unknown_unlock')),
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_media_unlock_payments_unlock ON media_unlock_payments (vertical, unlock_id);

ALTER TABLE movie_unlocks ADD COLUMN IF NOT EXISTS paid_at timestamptz;
ALTER TABLE music_unlocks ADD COLUMN IF NOT EXISTS paid_at timestamptz;
