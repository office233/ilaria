-- ============================================================================
-- Universal Marketplace — Faza 1: listing-uri tip anunț + verticale
-- Idempotent (safe to re-run).
-- ============================================================================

-- 1. listing_type pe marketplace_products:
--    'product'  = cumpărabil cu coș (default, comportament existent)
--    'listing'  = anunț cu formular contact (imobiliare, auto, servicii)
ALTER TABLE marketplace_products
  ADD COLUMN IF NOT EXISTS listing_type text NOT NULL DEFAULT 'product';

DO $$ BEGIN
  ALTER TABLE marketplace_products
    ADD CONSTRAINT marketplace_products_listing_type_check
    CHECK (listing_type IN ('product', 'listing'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. Atribute specifice verticalei (mp, camere, an, km, ...) — jsonb indexat
ALTER TABLE marketplace_products
  ADD COLUMN IF NOT EXISTS vertical_attributes jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_mp_vertical_attributes
  ON marketplace_products USING gin (vertical_attributes jsonb_path_ops);

CREATE INDEX IF NOT EXISTS idx_mp_listing_type
  ON marketplace_products (listing_type) WHERE listing_type <> 'product';

-- 3. Locație pentru anunțuri (oraș/țară/coordonate — internațional)
ALTER TABLE marketplace_products
  ADD COLUMN IF NOT EXISTS location_country char(2),
  ADD COLUMN IF NOT EXISTS location_city text,
  ADD COLUMN IF NOT EXISTS location_lat double precision,
  ADD COLUMN IF NOT EXISTS location_lng double precision;

CREATE INDEX IF NOT EXISTS idx_mp_location
  ON marketplace_products (location_country, location_city)
  WHERE location_country IS NOT NULL;

-- 4. Contact pentru anunțuri (telefon afișat opțional pe anunț)
ALTER TABLE marketplace_products
  ADD COLUMN IF NOT EXISTS contact_phone text,
  ADD COLUMN IF NOT EXISTS contact_email text;

-- 5. inquiry_requests — lead-uri generate de anunțuri
CREATE TABLE IF NOT EXISTS inquiry_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES marketplace_products(id) ON DELETE CASCADE,
  user_id uuid,                          -- opțional: user logat
  name text NOT NULL,
  email text,
  phone text,
  message text NOT NULL,
  status text NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'contacted', 'closed', 'spam')),
  ip_hash text,                          -- anti-spam
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inquiry_has_contact CHECK (email IS NOT NULL OR phone IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_inquiry_product ON inquiry_requests (product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inquiry_status ON inquiry_requests (status) WHERE status = 'new';

-- 6. Departamente noi în taxonomie (verticale universale)
INSERT INTO taxonomy_nodes (slug, parent_slug, kind, sort_order, is_active, metadata)
VALUES
  ('real-estate', NULL, 'department', 100, true, '{"listing_type":"listing","icon":"home"}'),
  ('real-estate/apartments-sale', 'real-estate', 'category', 1, true, '{}'),
  ('real-estate/apartments-rent', 'real-estate', 'category', 2, true, '{}'),
  ('real-estate/houses-sale', 'real-estate', 'category', 3, true, '{}'),
  ('real-estate/houses-rent', 'real-estate', 'category', 4, true, '{}'),
  ('real-estate/land', 'real-estate', 'category', 5, true, '{}'),
  ('real-estate/commercial', 'real-estate', 'category', 6, true, '{}'),
  ('vehicles', NULL, 'department', 101, true, '{"listing_type":"listing","icon":"car"}'),
  ('vehicles/cars', 'vehicles', 'category', 1, true, '{}'),
  ('vehicles/motorcycles', 'vehicles', 'category', 2, true, '{}'),
  ('vehicles/trucks', 'vehicles', 'category', 3, true, '{}'),
  ('vehicles/parts', 'vehicles', 'category', 4, true, '{"listing_type":"product"}'),
  ('services', NULL, 'department', 102, true, '{"listing_type":"listing","icon":"wrench"}'),
  ('services/home-repair', 'services', 'category', 1, true, '{}'),
  ('services/beauty', 'services', 'category', 2, true, '{}'),
  ('services/education', 'services', 'category', 3, true, '{}'),
  ('services/events', 'services', 'category', 4, true, '{}'),
  ('services/transport', 'services', 'category', 5, true, '{}')
ON CONFLICT (slug) DO NOTHING;

-- 7. Traduceri RO + EN + DE pentru nodurile noi
INSERT INTO taxonomy_translations (node_slug, locale, label) VALUES
  ('real-estate', 'ro', 'Imobiliare'), ('real-estate', 'en', 'Real Estate'), ('real-estate', 'de', 'Immobilien'),
  ('real-estate/apartments-sale', 'ro', 'Apartamente de vânzare'), ('real-estate/apartments-sale', 'en', 'Apartments for Sale'), ('real-estate/apartments-sale', 'de', 'Wohnungen zum Verkauf'),
  ('real-estate/apartments-rent', 'ro', 'Apartamente de închiriat'), ('real-estate/apartments-rent', 'en', 'Apartments for Rent'), ('real-estate/apartments-rent', 'de', 'Wohnungen zur Miete'),
  ('real-estate/houses-sale', 'ro', 'Case de vânzare'), ('real-estate/houses-sale', 'en', 'Houses for Sale'), ('real-estate/houses-sale', 'de', 'Häuser zum Verkauf'),
  ('real-estate/houses-rent', 'ro', 'Case de închiriat'), ('real-estate/houses-rent', 'en', 'Houses for Rent'), ('real-estate/houses-rent', 'de', 'Häuser zur Miete'),
  ('real-estate/land', 'ro', 'Terenuri'), ('real-estate/land', 'en', 'Land'), ('real-estate/land', 'de', 'Grundstücke'),
  ('real-estate/commercial', 'ro', 'Spații comerciale'), ('real-estate/commercial', 'en', 'Commercial Property'), ('real-estate/commercial', 'de', 'Gewerbeimmobilien'),
  ('vehicles', 'ro', 'Vehicule'), ('vehicles', 'en', 'Vehicles'), ('vehicles', 'de', 'Fahrzeuge'),
  ('vehicles/cars', 'ro', 'Autoturisme'), ('vehicles/cars', 'en', 'Cars'), ('vehicles/cars', 'de', 'Autos'),
  ('vehicles/motorcycles', 'ro', 'Motociclete'), ('vehicles/motorcycles', 'en', 'Motorcycles'), ('vehicles/motorcycles', 'de', 'Motorräder'),
  ('vehicles/trucks', 'ro', 'Camioane și utilitare'), ('vehicles/trucks', 'en', 'Trucks & Vans'), ('vehicles/trucks', 'de', 'LKW & Transporter'),
  ('vehicles/parts', 'ro', 'Piese auto'), ('vehicles/parts', 'en', 'Auto Parts'), ('vehicles/parts', 'de', 'Autoteile'),
  ('services', 'ro', 'Servicii'), ('services', 'en', 'Services'), ('services', 'de', 'Dienstleistungen'),
  ('services/home-repair', 'ro', 'Reparații și amenajări'), ('services/home-repair', 'en', 'Home Repair'), ('services/home-repair', 'de', 'Reparatur & Renovierung'),
  ('services/beauty', 'ro', 'Frumusețe'), ('services/beauty', 'en', 'Beauty'), ('services/beauty', 'de', 'Schönheit'),
  ('services/education', 'ro', 'Educație și meditații'), ('services/education', 'en', 'Education & Tutoring'), ('services/education', 'de', 'Bildung & Nachhilfe'),
  ('services/events', 'ro', 'Evenimente'), ('services/events', 'en', 'Events'), ('services/events', 'de', 'Veranstaltungen'),
  ('services/transport', 'ro', 'Transport și mutări'), ('services/transport', 'en', 'Transport & Moving'), ('services/transport', 'de', 'Transport & Umzug')
ON CONFLICT DO NOTHING;
