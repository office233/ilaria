-- Swypik Stays — aplicații de gazdă (onboarding cu verificare manuală).
--
-- Conformitate România (legislație turism):
--   - OG 58/1998 + Ordin 65/2013: structurile de primire turistică au nevoie de
--     CERTIFICAT DE CLASIFICARE (hotel/pensiune) emis de Ministerul Turismului.
--   - Legea 170/2016 + Cod Fiscal: PFA/SRL sau impozitare pe venituri din
--     închiriere în scop turistic (max 5 camere ca persoană fizică — regim
--     special ANAF, declarația unică).
--   - Verificăm dreptul de proprietate/folosință (extras CF sau contract).
-- Nimic nu se publică fără review manual (status pending → approved).

CREATE TABLE IF NOT EXISTS host_applications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID,                          -- legat de cont dacă e logat
    status TEXT NOT NULL DEFAULT 'pending', -- pending|approved|rejected|needs_info
    -- Identitate gazdă
    full_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT NOT NULL,
    -- Entitate legală
    entity_type TEXT NOT NULL,             -- persoana_fizica|pfa|srl
    company_name TEXT,                     -- pt PFA/SRL
    cui TEXT,                              -- CUI/CIF pt PFA/SRL; CNP nu se stochează
    -- Proprietatea
    property_name TEXT NOT NULL,
    property_type TEXT NOT NULL,           -- apartament|casa|pensiune|hotel|cabana|vila
    address TEXT NOT NULL,
    city TEXT NOT NULL,
    county TEXT NOT NULL,
    rooms INTEGER NOT NULL DEFAULT 1,
    max_guests INTEGER NOT NULL DEFAULT 2,
    -- Conformitate legală RO
    classification_cert TEXT,              -- nr. certificat de clasificare (obligatoriu pensiune/hotel)
    ownership_doc_url TEXT,                -- extras CF / contract comodat/închiriere (upload)
    id_doc_url TEXT,                       -- act identitate reprezentant (upload)
    tourism_registered BOOLEAN NOT NULL DEFAULT false, -- declară înregistrarea la ANAF/minister
    -- Review
    admin_notes TEXT,
    reviewed_by TEXT,
    reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_host_apps_status ON host_applications (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_host_apps_user ON host_applications (user_id) WHERE user_id IS NOT NULL;
