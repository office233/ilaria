/** Tipuri + constante Go folosibile și în client (fără importuri de server). */
export const DRIVER_DOCUMENT_TYPES = [
  "id_card",
  "driving_license",
  "arr_attestation",
  "rca_insurance",
  "itp",
  "vehicle_registration",
  "criminal_record",
] as const;
export type DriverDocumentType = (typeof DRIVER_DOCUMENT_TYPES)[number];

export type GoSettings = {
  card_enabled: boolean;
  cash_enabled: boolean;
  free_cancel_grace_seconds: number;
  fare_overrun_cap_bps: number;
  payment_auth_ttl_minutes: number;
  required_driver_documents: DriverDocumentType[];
};
