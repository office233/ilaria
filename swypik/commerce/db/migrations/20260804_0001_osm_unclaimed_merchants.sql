-- Profiluri de restaurante "unclaimed" importate din OpenStreetMap + flow de revendicare.
-- seller_id IS NULL = profil nerevendicat. source/osm_id = proveniența + dedupe la reimport.

ALTER TABLE local_merchants ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';
ALTER TABLE local_merchants ADD COLUMN IF NOT EXISTS osm_id bigint;
ALTER TABLE local_merchants ADD COLUMN IF NOT EXISTS osm_type text; -- node | way | relation

-- dedupe: un element OSM apare o singură dată
CREATE UNIQUE INDEX IF NOT EXISTS local_merchants_osm_uniq
  ON local_merchants (osm_type, osm_id)
  WHERE osm_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS local_merchants_city_kind_idx
  ON local_merchants (location_city, kind, status);

-- Cereri de revendicare a unui profil unclaimed
CREATE TABLE IF NOT EXISTS merchant_claim_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES local_merchants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,               -- contul care revendică
  contact_name text,
  contact_phone text NOT NULL,
  contact_email text,
  message text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS merchant_claim_requests_status_idx
  ON merchant_claim_requests (status, created_at DESC);
CREATE INDEX IF NOT EXISTS merchant_claim_requests_merchant_idx
  ON merchant_claim_requests (merchant_id);
