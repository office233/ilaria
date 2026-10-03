-- ============================================================================
-- Swypik Cares — donații: românii donează pentru România.
-- Comision 0% de la platformă (doar taxa de procesare a plății).
-- Transparență totală: fiecare campanie arată cât s-a strâns și cum s-a plătit.
-- Idempotent.
-- ============================================================================

-- Beneficiari verificați: ONG-uri, familii, business-uri mici la început.
CREATE TABLE IF NOT EXISTS donation_causes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL DEFAULT 'ngo'
    CHECK (kind IN ('ngo', 'family', 'small_business', 'community', 'emergency')),
  name text NOT NULL,
  slug text UNIQUE,
  description text,
  -- verificare (documente, CUI/CIF pentru ONG, acte pentru familii)
  legal_id text,                                   -- CUI / CIF / CNP hash
  documents jsonb NOT NULL DEFAULT '{}'::jsonb,
  verification_status text NOT NULL DEFAULT 'pending'
    CHECK (verification_status IN ('pending', 'in_review', 'verified', 'rejected')),
  verified_at timestamptz,
  verified_by uuid,
  -- contact & plată
  contact_name text,
  contact_email text,
  contact_phone text,
  payout_details jsonb NOT NULL DEFAULT '{}'::jsonb,
  location_country char(2) DEFAULT 'RO',
  location_city text,
  image_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_causes_verified
  ON donation_causes (verification_status) WHERE verification_status = 'verified';

-- Campanii concrete, cu țintă și termen.
CREATE TABLE IF NOT EXISTS donation_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cause_id uuid NOT NULL REFERENCES donation_causes(id) ON DELETE CASCADE,
  title text NOT NULL,
  slug text UNIQUE,
  story text,                                      -- povestea, afișată sub clip
  goal_cents integer NOT NULL CHECK (goal_cents > 0),
  raised_cents integer NOT NULL DEFAULT 0 CHECK (raised_cents >= 0),
  currency char(3) NOT NULL DEFAULT 'RON',
  -- ce se face concret cu banii (transparență)
  budget_breakdown jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'funded', 'closed', 'suspended')),
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz,
  image_url text,
  video_id uuid,                                   -- clipul din feed
  donors_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campaign_dates CHECK (ends_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS idx_campaigns_active
  ON donation_campaigns (status, ends_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_campaigns_cause ON donation_campaigns (cause_id);

-- Donații individuale.
CREATE TABLE IF NOT EXISTS donations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES donation_campaigns(id) ON DELETE CASCADE,
  donor_user_id uuid,                              -- null = donație anonimă/neautentificat
  donor_name text,
  donor_email text,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  currency char(3) NOT NULL DEFAULT 'RON',
  message text,
  is_anonymous boolean NOT NULL DEFAULT false,
  -- plată
  payment_provider text NOT NULL DEFAULT 'stripe',
  payment_intent_id text,
  payment_status text NOT NULL DEFAULT 'pending'
    CHECK (payment_status IN ('pending', 'paid', 'failed', 'refunded')),
  paid_at timestamptz,
  -- rotunjire la checkout („adaugi 2 lei pentru o familie?”)
  source text NOT NULL DEFAULT 'direct'
    CHECK (source IN ('direct', 'checkout_roundup', 'recurring')),
  ip_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_donations_campaign ON donations (campaign_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_donations_user ON donations (donor_user_id) WHERE donor_user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_donations_intent
  ON donations (payment_intent_id) WHERE payment_intent_id IS NOT NULL;

-- Plăți către beneficiari (transparență: unde s-au dus banii).
CREATE TABLE IF NOT EXISTS donation_payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES donation_campaigns(id),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  currency char(3) NOT NULL DEFAULT 'RON',
  purpose text NOT NULL,                           -- „plată factură spital”, „materiale”
  proof_url text,                                  -- dovada (factură, chitanță)
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'confirmed', 'failed')),
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payouts_campaign ON donation_payouts (campaign_id, created_at DESC);

-- Taxonomie
INSERT INTO taxonomy_nodes (slug, parent_slug, kind, sort_order, is_active, metadata) VALUES
  ('donations', NULL, 'department', 50, true, '{"vertical":"cares"}'),
  ('donations/ngo',            'donations', 'category', 1, true, '{}'),
  ('donations/family',         'donations', 'category', 2, true, '{}'),
  ('donations/small-business', 'donations', 'category', 3, true, '{}'),
  ('donations/community',      'donations', 'category', 4, true, '{}'),
  ('donations/emergency',      'donations', 'category', 5, true, '{}')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO taxonomy_translations (node_slug, locale, label) VALUES
  ('donations','ro','Donații'), ('donations','en','Donations'), ('donations','de','Spenden'),
  ('donations/ngo','ro','ONG-uri'), ('donations/ngo','en','NGOs'), ('donations/ngo','de','NGOs'),
  ('donations/family','ro','Familii'), ('donations/family','en','Families'), ('donations/family','de','Familien'),
  ('donations/small-business','ro','Afaceri mici'), ('donations/small-business','en','Small Business'), ('donations/small-business','de','Kleinunternehmen'),
  ('donations/community','ro','Comunitate'), ('donations/community','en','Community'), ('donations/community','de','Gemeinschaft'),
  ('donations/emergency','ro','Urgențe'), ('donations/emergency','en','Emergency'), ('donations/emergency','de','Notfälle')
ON CONFLICT DO NOTHING;
