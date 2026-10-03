import { isUuid } from "@/lib/validation/uuid";

/** Peste atâtea id-uri într-un request, refuzăm — o pagină de feed are 12. */
export const MAX_LIKED_IDS = 50;

export type ParsedIds =
    | { ok: true; ids: string[] }
    | { ok: false; error: "too_many_ids" | "invalid_id" };

/**
 * Validează parametrul `ids` al rutei `/api/feed/offers/liked`.
 *
 * Stă în `lib/`, nu în fișierul rutei, fiindcă Next.js permite într-un
 * `route.ts` doar exporturi cunoscute (GET, POST, dynamic, ...). Orice altceva
 * exportat de acolo pică la `tsc` prin tipurile generate în `.next/types`.
 */
export function parseLikedIds(raw: string | null): ParsedIds {
    const ids = [...new Set((raw ?? "").split(",").map((s) => s.trim()).filter(Boolean))];
    if (ids.length > MAX_LIKED_IDS) return { ok: false, error: "too_many_ids" };
    if (!ids.every(isUuid)) return { ok: false, error: "invalid_id" };
    return { ok: true, ids };
}
