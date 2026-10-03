-- 20260926_0051_stays_single_host_model
--
-- Un SINGUR model de gazdă pentru Stays (audit stays.md §1, plan pas 3).
--
-- Înainte existau trei:
--   A. gazde Swypik (host_applications aprobate) → marketplace_products cu
--      metadata.host_user_id — panoul /stays/manage + /api/host/*
--   B. calendarul vechi de seller (/seller/cazari, /api/stays/mine,
--      POST /api/stays/availability) — listări legate doar prin seller_id
--   C. anunțuri universale /api/listings cu taxonomia vacation-rentals/*,
--      preț în vertical_attributes.price_per_night (LEI, nu bani)
-- La B și C gazda nu era plătită niciodată (lipsea host_user_id).
--
-- Acum: modelul canonic este `stay_hosts` (o gazdă = un user) + listarea în
-- marketplace_products cu metadata.vertical='stays' și metadata.host_user_id.
--
-- Maparea datelor (fără DROP, fără DELETE):
--   A → stay_hosts(source='application') pentru aplicațiile aprobate cu user.
--   B/C → dacă sellerul are cont de user (sellers.user_id), listarea primește
--         host_user_id = sellers.user_id și gazda intră în stay_hosts
--         (source='seller'); prețul/noapte din vertical_attributes (lei) e
--         copiat în price_cents (bani), max_guests în metadata.
--   B/C fără user → metadata.stays_unclaimed = true: rămân în DB, dar nu mai
--         apar în /stays și nu se pot rezerva (nu are cine să primească banii).
--   Toate listările migrate primesc metadata.stays_legacy_model ('B'|'C')
--   pentru trasabilitate.
--
-- Tabele vechi păstrate DOAR-CITIRE (documentat, nu șterse):
--   stay_hotel_bookings — nefolosită niciodată (inventar extern nelansat);
--                         trigger care refuză orice scriere.
-- Rutele modelelor B/C sunt retrase în cod (410 / redirect), nu în DB.

CREATE TABLE IF NOT EXISTS stay_hosts (
  user_id uuid PRIMARY KEY,
  source text NOT NULL CHECK (source IN ('application','seller')),
  host_application_id uuid,
  legacy_seller_id uuid,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE stay_hosts IS
  'Model unic de gazdă Stays (20260926_0051). Listările: marketplace_products.metadata.host_user_id = stay_hosts.user_id.';

-- A: aplicații aprobate (cea mai recentă per user).
INSERT INTO stay_hosts (user_id, source, host_application_id)
SELECT DISTINCT ON (a.user_id) a.user_id, 'application', a.id
  FROM host_applications a
 WHERE a.status = 'approved' AND a.user_id IS NOT NULL
 ORDER BY a.user_id, a.reviewed_at DESC NULLS LAST
ON CONFLICT (user_id) DO NOTHING;

-- B/C: listări vacation-rentals fără gazdă, al căror seller are cont de user.
INSERT INTO stay_hosts (user_id, source, legacy_seller_id)
SELECT DISTINCT s.user_id, 'seller', s.id
  FROM marketplace_products p
  JOIN sellers s ON s.id = p.seller_id
 WHERE p.taxonomy_node_slug LIKE 'vacation-rentals%'
   AND COALESCE(p.metadata->>'host_user_id', '') = ''
   AND s.user_id IS NOT NULL
ON CONFLICT (user_id) DO NOTHING;

UPDATE marketplace_products p
   SET metadata = COALESCE(p.metadata, '{}'::jsonb)
         || jsonb_build_object(
              'vertical', 'stays',
              'host_user_id', s.user_id::text,
              'stays_legacy_model', CASE WHEN p.metadata ? 'seller_id' THEN 'C' ELSE 'B' END
            )
         || CASE WHEN (p.vertical_attributes->>'max_guests') ~ '^[0-9]+$'
                 THEN jsonb_build_object('max_guests', (p.vertical_attributes->>'max_guests')::int)
                 ELSE '{}'::jsonb END,
       price_cents = COALESCE(
         NULLIF(p.price_cents, 0),
         CASE WHEN (p.vertical_attributes->>'price_per_night') ~ '^[0-9]+(\.[0-9]+)?$'
              THEN round((p.vertical_attributes->>'price_per_night')::numeric * 100)::int END
       ),
       updated_at = now()
  FROM sellers s
 WHERE s.id = p.seller_id
   AND p.taxonomy_node_slug LIKE 'vacation-rentals%'
   AND COALESCE(p.metadata->>'host_user_id', '') = ''
   AND s.user_id IS NOT NULL;

-- Fără cont de user → nerevendicate (ascunse din Stays, nerezervabile).
UPDATE marketplace_products p
   SET metadata = COALESCE(p.metadata, '{}'::jsonb)
         || jsonb_build_object(
              'stays_unclaimed', true,
              'stays_legacy_model', CASE WHEN p.metadata ? 'seller_id' THEN 'C' ELSE 'B' END
            ),
       updated_at = now()
 WHERE p.taxonomy_node_slug LIKE 'vacation-rentals%'
   AND COALESCE(p.metadata->>'host_user_id', '') = ''
   AND NOT (COALESCE(p.metadata, '{}'::jsonb) ? 'stays_unclaimed');

-- Listări ale gazdelor A: garantează vertical='stays' (unele vechi aveau doar taxonomia).
UPDATE marketplace_products
   SET metadata = metadata || '{"vertical":"stays"}'::jsonb
 WHERE metadata->>'host_user_id' IS NOT NULL
   AND taxonomy_node_slug LIKE 'vacation-rentals%'
   AND COALESCE(metadata->>'vertical', '') <> 'stays';

-- Rezervările listărilor tocmai mapate primesc gazda (0050 a completat doar modelul A).
UPDATE stay_bookings b
   SET host_user_id = (p.metadata->>'host_user_id')::uuid
  FROM marketplace_products p
 WHERE p.id = b.product_id
   AND b.host_user_id IS NULL
   AND p.metadata->>'host_user_id' ~* '^[0-9a-f-]{36}$';

CREATE INDEX IF NOT EXISTS idx_mp_stays_host
  ON marketplace_products ((metadata->>'host_user_id'))
  WHERE metadata->>'vertical' = 'stays';

-- stay_hotel_bookings: doar-citire (nefolosită; păstrată pentru istoric).
CREATE OR REPLACE FUNCTION stays_forbid_legacy_write() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % is read-only since 20260926_0051 (Stays single host model)', TG_TABLE_NAME;
END $$;

DO $$ BEGIN
  IF to_regclass('public.stay_hotel_bookings') IS NOT NULL THEN
    COMMENT ON TABLE stay_hotel_bookings IS
      'READ-ONLY din 20260926_0051: inventar extern (Duffel/RateHawk) nelansat, nicio scriere din cod. Nu se șterge fără decizia owner-ului.';
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'stay_hotel_bookings_readonly') THEN
      CREATE TRIGGER stay_hotel_bookings_readonly
        BEFORE INSERT OR UPDATE OR DELETE ON stay_hotel_bookings
        FOR EACH ROW EXECUTE FUNCTION stays_forbid_legacy_write();
    END IF;
  END IF;
END $$;
