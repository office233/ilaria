-- ============================================================================
-- Universal Marketplace — Faza 2: servicii locale
--   • merchants (restaurante, magazine locale) cu meniuri/program
--   • couriers (curieri + șoferi) cu onboarding și tracking
--   • local_orders (comenzi food/livrări) + dispatch
--   • rides (curse taxi) — schelet pentru faza taxi
--   • stays (cazări/chirii/vacanțe) cu calendar disponibilitate
-- Idempotent.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- 1. MERCHANTS — entități locale cu program și zonă de livrare
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS local_merchants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id uuid,                              -- legătura cu contul de seller existent
  kind text NOT NULL DEFAULT 'restaurant'
    CHECK (kind IN ('restaurant', 'grocery', 'pharmacy', 'flowers', 'other')),
  name text NOT NULL,
  slug text UNIQUE,
  description text,
  cuisine_types text[] DEFAULT '{}',           -- ['pizza','burger','asian']
  phone text,
  email text,
  address text,
  location_country char(2),
  location_city text,
  location_lat double precision,
  location_lng double precision,
  delivery_radius_km numeric(5,1) DEFAULT 5.0,
  min_order_cents integer DEFAULT 0,
  delivery_fee_cents integer DEFAULT 0,
  avg_prep_minutes integer DEFAULT 20,
  opening_hours jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {"mon":[["09:00","22:00"]],...}
  is_open_override boolean,                    -- forțat închis/deschis de merchant
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'suspended', 'closed')),
  rating numeric(3,2),
  image_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lm_city ON local_merchants (location_country, location_city) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_lm_seller ON local_merchants (seller_id);

-- Meniu: categorii + articole cu opțiuni (mărime, toppinguri)
CREATE TABLE IF NOT EXISTS menu_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES local_merchants(id) ON DELETE CASCADE,
  name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 100,
  is_active boolean NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS idx_mc_merchant ON menu_categories (merchant_id, sort_order);

CREATE TABLE IF NOT EXISTS menu_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES local_merchants(id) ON DELETE CASCADE,
  category_id uuid REFERENCES menu_categories(id) ON DELETE SET NULL,
  name text NOT NULL,
  description text,
  price_cents integer NOT NULL CHECK (price_cents >= 0),
  currency char(3) NOT NULL DEFAULT 'RON',
  image_url text,
  is_available boolean NOT NULL DEFAULT true,
  -- opțiuni: [{"name":"Mărime","required":true,"max":1,"choices":[{"name":"Mare","price_cents":500}]}]
  options jsonb NOT NULL DEFAULT '[]'::jsonb,
  allergens text[] DEFAULT '{}',
  sort_order integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mi_merchant ON menu_items (merchant_id, sort_order) WHERE is_available;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. COURIERS — curieri (food/colete) și șoferi (taxi, faza 3)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS couriers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,                                -- legat de contul user existent
  kind text NOT NULL DEFAULT 'courier' CHECK (kind IN ('courier', 'driver')),
  full_name text NOT NULL,
  phone text NOT NULL,
  email text,
  vehicle_type text NOT NULL DEFAULT 'bike'
    CHECK (vehicle_type IN ('foot', 'bike', 'scooter', 'motorcycle', 'car', 'van')),
  vehicle_plate text,
  city text NOT NULL,
  country char(2) NOT NULL DEFAULT 'RO',
  -- onboarding: documente încărcate + verificare
  documents jsonb NOT NULL DEFAULT '{}'::jsonb, -- {"id_card":"url","license":"url","insurance":"url"}
  verification_status text NOT NULL DEFAULT 'pending'
    CHECK (verification_status IN ('pending', 'in_review', 'approved', 'rejected')),
  verification_notes text,
  -- disponibilitate live
  is_online boolean NOT NULL DEFAULT false,
  current_lat double precision,
  current_lng double precision,
  location_updated_at timestamptz,
  -- payouts
  payout_details jsonb NOT NULL DEFAULT '{}'::jsonb,
  rating numeric(3,2),
  completed_deliveries integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_couriers_user ON couriers (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_couriers_online ON couriers (city, is_online) WHERE is_online;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. LOCAL ORDERS — comenzi food/livrare locală cu dispatch
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS local_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number text UNIQUE NOT NULL DEFAULT ('LO-' || upper(substr(md5(random()::text), 1, 8))),
  merchant_id uuid NOT NULL REFERENCES local_merchants(id),
  customer_user_id uuid,
  customer_name text NOT NULL,
  customer_phone text NOT NULL,
  -- adresa de livrare
  delivery_address text NOT NULL,
  delivery_lat double precision,
  delivery_lng double precision,
  delivery_notes text,
  -- items: [{"menu_item_id":"...","name":"...","qty":2,"unit_price_cents":2500,"options":[...]}]
  items jsonb NOT NULL,
  subtotal_cents integer NOT NULL CHECK (subtotal_cents >= 0),
  delivery_fee_cents integer NOT NULL DEFAULT 0,
  tip_cents integer NOT NULL DEFAULT 0,
  total_cents integer NOT NULL CHECK (total_cents >= 0),
  currency char(3) NOT NULL DEFAULT 'RON',
  payment_method text NOT NULL DEFAULT 'cash' CHECK (payment_method IN ('cash', 'card_online', 'card_courier')),
  payment_status text NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending', 'paid', 'refunded', 'failed')),
  -- fluxul comenzii
  status text NOT NULL DEFAULT 'placed' CHECK (status IN (
    'placed',       -- clientul a plasat
    'accepted',     -- restaurantul a acceptat
    'preparing',    -- în bucătărie
    'ready',        -- gata de ridicare
    'picked_up',    -- curierul a ridicat
    'delivering',   -- pe drum
    'delivered',    -- livrat
    'cancelled',    -- anulat
    'rejected'      -- refuzat de merchant
  )),
  cancel_reason text,
  -- dispatch
  courier_id uuid REFERENCES couriers(id),
  dispatch_status text NOT NULL DEFAULT 'none'
    CHECK (dispatch_status IN ('none', 'searching', 'offered', 'assigned', 'no_courier')),
  estimated_delivery_at timestamptz,
  placed_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  ready_at timestamptz,
  picked_up_at timestamptz,
  delivered_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lo_merchant ON local_orders (merchant_id, placed_at DESC);
CREATE INDEX IF NOT EXISTS idx_lo_courier ON local_orders (courier_id) WHERE courier_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lo_active ON local_orders (status) WHERE status NOT IN ('delivered','cancelled','rejected');
CREATE INDEX IF NOT EXISTS idx_lo_customer ON local_orders (customer_user_id, placed_at DESC) WHERE customer_user_id IS NOT NULL;

-- Ofertele de dispatch către curieri (istoric cine a primit/refuzat)
CREATE TABLE IF NOT EXISTS dispatch_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES local_orders(id) ON DELETE CASCADE,
  courier_id uuid NOT NULL REFERENCES couriers(id),
  offered_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  response text CHECK (response IN ('accepted', 'declined', 'expired')),
  responded_at timestamptz,
  UNIQUE (order_id, courier_id)
);
CREATE INDEX IF NOT EXISTS idx_do_pending ON dispatch_offers (courier_id) WHERE response IS NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- 4. RIDES — schelet taxi (faza 3; păstrează compatibilitate cu couriers.kind='driver')
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rider_user_id uuid,
  driver_id uuid REFERENCES couriers(id),
  pickup_address text NOT NULL,
  pickup_lat double precision NOT NULL,
  pickup_lng double precision NOT NULL,
  dropoff_address text NOT NULL,
  dropoff_lat double precision NOT NULL,
  dropoff_lng double precision NOT NULL,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN (
    'requested', 'searching', 'accepted', 'arriving', 'in_progress', 'completed', 'cancelled'
  )),
  estimated_fare_cents integer,
  final_fare_cents integer,
  currency char(3) NOT NULL DEFAULT 'RON',
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_rides_active ON rides (status) WHERE status NOT IN ('completed','cancelled');

-- ────────────────────────────────────────────────────────────────────────────
-- 5. STAYS — cazări: vânzare/chirie pe termen lung există ca listing;
--    aici e închirierea pe nopți (vacanțe) cu calendar
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stay_availability (
  product_id uuid NOT NULL REFERENCES marketplace_products(id) ON DELETE CASCADE,
  day date NOT NULL,
  is_available boolean NOT NULL DEFAULT true,
  price_cents_override integer,                -- preț special pe zi (sezon)
  PRIMARY KEY (product_id, day)
);

CREATE TABLE IF NOT EXISTS stay_bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES marketplace_products(id),
  guest_user_id uuid,
  guest_name text NOT NULL,
  guest_email text,
  guest_phone text,
  check_in date NOT NULL,
  check_out date NOT NULL CHECK (check_out > check_in),
  guests_count integer NOT NULL DEFAULT 1 CHECK (guests_count > 0),
  total_cents integer NOT NULL CHECK (total_cents >= 0),
  currency char(3) NOT NULL DEFAULT 'EUR',
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'cancelled', 'completed')),
  payment_status text NOT NULL DEFAULT 'pending'
    CHECK (payment_status IN ('pending', 'paid', 'refunded')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT booking_has_contact CHECK (guest_email IS NOT NULL OR guest_phone IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_sb_product ON stay_bookings (product_id, check_in);

-- Previne dublă rezervare pe același interval (exclusion constraint)
DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS btree_gist;
  ALTER TABLE stay_bookings ADD CONSTRAINT stay_no_overlap
    EXCLUDE USING gist (
      product_id WITH =,
      daterange(check_in, check_out) WITH &&
    ) WHERE (status IN ('pending', 'confirmed'));
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 6. Taxonomie: verticale noi (food, cazări vacanțe)
-- ────────────────────────────────────────────────────────────────────────────
INSERT INTO taxonomy_nodes (slug, parent_slug, kind, sort_order, is_active, metadata) VALUES
  ('food', NULL, 'department', 103, true, '{"vertical":"food","icon":"utensils"}'),
  ('vacation-rentals', NULL, 'department', 104, true, '{"listing_type":"listing","vertical":"stays","icon":"palm"}'),
  ('vacation-rentals/apartments', 'vacation-rentals', 'category', 1, true, '{}'),
  ('vacation-rentals/houses', 'vacation-rentals', 'category', 2, true, '{}'),
  ('vacation-rentals/cabins', 'vacation-rentals', 'category', 3, true, '{}'),
  ('vacation-rentals/hotels', 'vacation-rentals', 'category', 4, true, '{}')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO taxonomy_translations (node_slug, locale, label) VALUES
  ('food', 'ro', 'Mâncare'), ('food', 'en', 'Food'), ('food', 'de', 'Essen'),
  ('vacation-rentals', 'ro', 'Cazări de vacanță'), ('vacation-rentals', 'en', 'Vacation Rentals'), ('vacation-rentals', 'de', 'Ferienunterkünfte'),
  ('vacation-rentals/apartments', 'ro', 'Apartamente'), ('vacation-rentals/apartments', 'en', 'Apartments'), ('vacation-rentals/apartments', 'de', 'Wohnungen'),
  ('vacation-rentals/houses', 'ro', 'Case de vacanță'), ('vacation-rentals/houses', 'en', 'Vacation Homes'), ('vacation-rentals/houses', 'de', 'Ferienhäuser'),
  ('vacation-rentals/cabins', 'ro', 'Cabane'), ('vacation-rentals/cabins', 'en', 'Cabins'), ('vacation-rentals/cabins', 'de', 'Hütten'),
  ('vacation-rentals/hotels', 'ro', 'Hoteluri și pensiuni'), ('vacation-rentals/hotels', 'en', 'Hotels & B&Bs'), ('vacation-rentals/hotels', 'de', 'Hotels & Pensionen')
ON CONFLICT DO NOTHING;
