-- Documente structurate pentru șoferi/curieri (audit go.md §4 Safety,
-- courier-fleet-apps.md §6.6). Înainte: doar `couriers.documents` jsonb liber.
-- Panoul șoferului arată ce e aprobat / lipsă / expirat; consola admin
-- revizuiește. Tipurile obligatorii sunt în go_settings.required_driver_documents.
-- (2026-09-26, w3-go) Idempotent; nu se șterge nimic din couriers.documents.

BEGIN;

CREATE TABLE IF NOT EXISTS courier_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  courier_id uuid NOT NULL REFERENCES couriers(id) ON DELETE CASCADE,
  doc_type text NOT NULL CHECK (doc_type IN (
    'id_card', 'driving_license', 'arr_attestation', 'rca_insurance',
    'itp', 'vehicle_registration', 'criminal_record'
  )),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  file_url text,
  expires_at date,
  notes text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (courier_id, doc_type)
);
CREATE INDEX IF NOT EXISTS idx_courier_documents_pending
  ON courier_documents (created_at) WHERE status = 'pending';

-- Backfill din jsonb-ul vechi {"id_card":"url","license":"url","insurance":"url"}.
INSERT INTO courier_documents (courier_id, doc_type, file_url)
SELECT c.id,
       CASE d.key
         WHEN 'license' THEN 'driving_license'
         WHEN 'insurance' THEN 'rca_insurance'
         ELSE d.key END,
       d.value
  FROM couriers c
  CROSS JOIN LATERAL jsonb_each_text(COALESCE(c.documents, '{}'::jsonb)) d
 WHERE (CASE d.key WHEN 'license' THEN 'driving_license' WHEN 'insurance' THEN 'rca_insurance' ELSE d.key END)
       IN ('id_card', 'driving_license', 'arr_attestation', 'rca_insurance', 'itp', 'vehicle_registration', 'criminal_record')
   AND d.value IS NOT NULL AND d.value <> ''
ON CONFLICT (courier_id, doc_type) DO NOTHING;

COMMIT;
