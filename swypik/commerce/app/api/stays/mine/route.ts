/**
 * RETRAS (20260926_0051, model unic de gazdă): calendarul vechi de seller.
 * Listările sellerilor cu cont au fost mutate la gazda lor; panoul e /stays/manage.
 */
import { staysError } from "@/lib/stays/errors";

export const dynamic = "force-dynamic";

export function GET(): Response {
    return staysError("legacy_retired");
}
