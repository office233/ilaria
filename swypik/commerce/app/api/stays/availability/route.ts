/**
 * RETRAS (20260926_0051, model unic de gazdă): calendarul vechi de seller.
 * Calendarul gazdei: /api/host/listings/[id]/availability;
 * calendarul public: GET /api/stays/bookings?product_id=….
 */
import { staysError } from "@/lib/stays/errors";

export const dynamic = "force-dynamic";

export function GET(): Response {
    return staysError("legacy_retired");
}

export function POST(): Response {
    return staysError("legacy_retired");
}
