-- Stripe Tax: tax_cents exists already in initial schema (CHECK >= 0).
-- Add country + collected VAT/Tax ID for compliance / receipts.
ALTER TABLE commerce_orders
  ADD COLUMN IF NOT EXISTS tax_country TEXT,
  ADD COLUMN IF NOT EXISTS tax_id_collected TEXT;
