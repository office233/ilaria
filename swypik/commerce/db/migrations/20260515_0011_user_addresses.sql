CREATE TABLE IF NOT EXISTS user_addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label text,
  recipient_name text NOT NULL,
  phone text,
  line1 text NOT NULL,
  line2 text,
  city text NOT NULL,
  region text,
  postal_code text NOT NULL,
  country_code char(2) NOT NULL DEFAULT 'RO',
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_user_addresses_user ON user_addresses(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_addresses_one_default ON user_addresses(user_id) WHERE is_default = true;
INSERT INTO schema_migrations (version, applied_at) VALUES ('20260515_0011', now()) ON CONFLICT DO NOTHING;
