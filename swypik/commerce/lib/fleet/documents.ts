/**
 * Documentele obligatorii ale șoferilor Go / curierilor Food (audit food-go #2–#4).
 *
 *  - șoferi (kind='driver'): lista din go_settings.required_driver_documents;
 *  - curieri Food (kind='courier'): env FOOD_COURIER_REQUIRED_DOCUMENTS
 *    (listă separată prin virgulă, implicit `id_card`; gol = niciun document).
 *
 * Un document „valid" = status 'approved' ȘI (fără expirare SAU expires_at ≥ azi).
 * Verificat la aprobare (PATCH /api/admin/fleet/[id]) și la dispatch
 * (emitWaveOffers + atribuirea manuală din consola admin).
 */
import { dbQuery } from "@/lib/db";
import { getGoSettings } from "@/lib/rides/settings";
import { DRIVER_DOCUMENT_TYPES, type DriverDocumentType } from "@/lib/rides/settings-shared";

export type CourierKind = "courier" | "driver";

/** Documentele legate de vehicul — se re-verifică la schimbarea numărului / tipului. */
export const VEHICLE_DOCUMENT_TYPES: readonly DriverDocumentType[] = ["vehicle_registration", "rca_insurance", "itp"];

function isDocType(v: string): v is DriverDocumentType {
  return (DRIVER_DOCUMENT_TYPES as readonly string[]).includes(v);
}

export function courierRequiredDocumentsFromEnv(raw = process.env.FOOD_COURIER_REQUIRED_DOCUMENTS): DriverDocumentType[] {
  if (raw === undefined) return ["id_card"];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(isDocType);
}

export async function requiredDocumentsFor(kind: CourierKind): Promise<DriverDocumentType[]> {
  if (kind === "driver") return (await getGoSettings()).required_driver_documents;
  return courierRequiredDocumentsFromEnv();
}

/**
 * SQL (alias `c` pentru couriers): toate documentele din parametrul `$param`
 * (text[]) sunt aprobate și neexpirate pentru curierul `c`.
 */
export function documentsValidSql(param: string): string {
  return `NOT EXISTS (
      SELECT 1 FROM unnest(${param}::text[]) AS req(doc_type)
       WHERE NOT EXISTS (
         SELECT 1 FROM courier_documents d
          WHERE d.courier_id = c.id AND d.doc_type = req.doc_type AND d.status = 'approved'
            AND (d.expires_at IS NULL OR d.expires_at >= current_date)))`;
}

/** Documentele obligatorii lipsă / neaprobate / expirate ale unui curier. */
export async function missingDocuments(courierId: string, required: readonly string[]): Promise<string[]> {
  if (!required.length) return [];
  const { rows } = await dbQuery<{ doc_type: string }>(
    `SELECT doc_type FROM courier_documents
      WHERE courier_id = $1 AND doc_type = ANY($2::text[]) AND status = 'approved'
        AND (expires_at IS NULL OR expires_at >= current_date)`,
    [courierId, required],
  );
  const ok = new Set(rows.map((r) => r.doc_type));
  return required.filter((d) => !ok.has(d));
}
