CREATE TABLE IF NOT EXISTS fx_rates (
  base TEXT NOT NULL DEFAULT 'EUR',
  quote TEXT NOT NULL,
  rate NUMERIC(18,8) NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (base, quote)
);
INSERT INTO fx_rates (base, quote, rate) VALUES
  ('EUR','RON', 4.97), ('EUR','USD', 1.08), ('EUR','GBP', 0.86),
  ('EUR','PLN', 4.31), ('EUR','HUF', 395), ('EUR','CZK', 25.2),
  ('EUR','CHF', 0.95), ('EUR','SEK', 11.3), ('EUR','NOK', 11.7),
  ('EUR','DKK', 7.46), ('EUR','EUR', 1.0)
ON CONFLICT (base, quote) DO NOTHING;
