-- Swypik Go — setări operaționale editabile din /admin/go (auditate prin
-- admin_audit_log). Un singur rând (id = 1). Înainte erau constante în cod
-- (grația de 2 minute la anulare, buffer-ul de autorizare) sau lipseau
-- (cash vs card). (2026-09-26, w3-go)
--
-- cash_enabled: implicit FALSE — decizia owner-ului (cash vs card) se ia din
-- consolă; cardul e metoda implicită, cu autorizare înainte de dispatch.
-- Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS go_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  card_enabled boolean NOT NULL DEFAULT true,
  cash_enabled boolean NOT NULL DEFAULT false,
  free_cancel_grace_seconds integer NOT NULL DEFAULT 120
    CHECK (free_cancel_grace_seconds BETWEEN 0 AND 3600),
  fare_overrun_cap_bps integer NOT NULL DEFAULT 2000
    CHECK (fare_overrun_cap_bps BETWEEN 0 AND 10000),
  payment_auth_ttl_minutes integer NOT NULL DEFAULT 15
    CHECK (payment_auth_ttl_minutes BETWEEN 2 AND 120),
  required_driver_documents text[] NOT NULL
    DEFAULT ARRAY['id_card', 'driving_license', 'arr_attestation', 'rca_insurance', 'vehicle_registration'],
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO go_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

COMMIT;
