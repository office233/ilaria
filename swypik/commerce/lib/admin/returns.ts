/**
 * Starea „retur în așteptare” a unei comenzi, ca predicat SQL pe
 * `commerce_orders` (fără alias). Cererea de retur scrie
 * metadata.return_status = 'requested'; comenzile vechi au doar
 * status = 'return_requested'. Folosit în UPDATE-uri condiționate ca
 * aprobarea/respingerea să fie tranziții unice (a doua → 0 rânduri → 409).
 */
export const RETURN_PENDING_SQL = `COALESCE(metadata->>'return_status',
  CASE WHEN status = 'return_requested' THEN 'requested' END) = 'requested'`;
