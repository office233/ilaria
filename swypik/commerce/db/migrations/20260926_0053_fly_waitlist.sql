-- 20260926_0053_fly_waitlist
--
-- Swypik Fly nu are încă furnizor de zboruri (audit fly.md): pagina /fly devine
-- „în curând / anunță-mă”. Aici se păstrează înscrierile (un email = un rând;
-- reînscrierea actualizează destinația/limba). Fără date de plată.
-- Idempotent.

CREATE TABLE IF NOT EXISTS fly_waitlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL CHECK (char_length(email) BETWEEN 3 AND 254),
  user_id uuid,
  origin text CHECK (origin IS NULL OR origin ~ '^[A-Z]{3}$'),
  destination text CHECK (destination IS NULL OR char_length(destination) <= 80),
  locale text NOT NULL DEFAULT 'ro',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  notified_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS fly_waitlist_email_uidx ON fly_waitlist (lower(email));
