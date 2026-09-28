-- Transparență SWYP: fiecare adresă on-chain care primește fonduri trebuie să
-- fie atribuibilă (utilizator înregistrat SAU etichetă manuală aici).
-- Raportul de reconciliere alertează pe orice adresă din afara acestor două seturi.

CREATE TABLE IF NOT EXISTS swyp_known_addresses (
    address      TEXT PRIMARY KEY CHECK (address = lower(address) AND address ~ '^0x[0-9a-f]{40}$'),
    label        TEXT NOT NULL,
    category     TEXT NOT NULL DEFAULT 'external' CHECK (category IN ('external','treasury','test','contract','burn')),
    added_by     TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE swyp_known_addresses IS
  'Adrese on-chain din afara swyp_chain_wallets, etichetate manual pentru trasabilitate 100% user↔fonduri.';

-- Adresele istorice externe identificate la auditul din 2026-08-09:
INSERT INTO swyp_known_addresses (address, label, category, added_by) VALUES
  ('0xdbd90f0e42a44ad703f7e9ddd9031df2a86ea59d', 'MetaMask extern - test transfer P2P abel_varga (2026-08-02)', 'test', 'audit-2026-08-09'),
  ('0x8d81d0852fe4fac9f1da3977016f73cd304a2971', 'Adresa test transfer qarider esuat (2026-08-03) - nu detine fonduri', 'test', 'audit-2026-08-09')
ON CONFLICT (address) DO NOTHING;
