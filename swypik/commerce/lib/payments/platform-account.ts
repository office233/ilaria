/**
 * FRONT R5 — contul tehnic al platformei în wallet_ledger.
 *
 * Comisionul fiecărei tranzacții (Eats + Go) se scrie ca intrare `credit`
 * pe acest user, cu ref_type 'commission_order' / 'commission_ride'.
 * De aici ies rapoartele de venituri (GET /api/admin/finance/summary).
 *
 * DECIZIE: user tehnic (rând `users`), nu o tabelă separată — reutilizează
 * întreaga infrastructură de ledger (idempotență pe (ref_type, ref_id, kind),
 * lock pe wallet_balances) fără cod duplicat. Id determinist, creat de
 * migrarea 20260730_0013; poate fi suprascris prin env PLATFORM_USER_ID
 * (util pe medii unde rândul a fost creat altfel).
 */
import { dbQuery } from "@/lib/db";
import { creditUser } from "@/lib/wallet/ledger";
import { logger } from "@/lib/logger";

const log = logger.child({ mod: "payments/platform-account" });

/** Id-ul din migrarea 20260730_0013_platform_account_connect.sql. */
export const DEFAULT_PLATFORM_USER_ID = "00000000-0000-0000-0000-00000000f1a7";

let cachedId: string | null = null;

/**
 * Id-ul contului de platformă. Verifică o singură dată că rândul există
 * (dacă env-ul indică un user inexistent, cădem pe id-ul din migrare).
 */
export async function getPlatformUserId(): Promise<string> {
    if (cachedId) return cachedId;

    const candidate = process.env.PLATFORM_USER_ID?.trim() || DEFAULT_PLATFORM_USER_ID;
    const { rows } = await dbQuery<{ id: string }>(
        `SELECT id FROM users WHERE id = $1::uuid LIMIT 1`,
        [candidate],
    );
    if (rows[0]) {
        cachedId = rows[0].id;
        return cachedId;
    }

    log.warn({ candidate }, "PLATFORM_USER_ID inexistent; folosesc id-ul din migrare");
    const { rows: fallback } = await dbQuery<{ id: string }>(
        `SELECT id FROM users WHERE id = $1::uuid LIMIT 1`,
        [DEFAULT_PLATFORM_USER_ID],
    );
    if (!fallback[0]) {
        throw new Error(
            "Contul de platformă lipsește. Aplică db/migrations/20260730_0013_platform_account_connect.sql",
        );
    }
    cachedId = fallback[0].id;
    return cachedId;
}

/**
 * Înregistrează comisionul platformei. Idempotent după (refType, refId).
 * amountCents <= 0 → no-op (comision zero e legitim, ex. promoții).
 */
export async function recordCommission(args: {
    refType: "commission_order" | "commission_ride";
    refId: string;
    amountCents: number;
    description?: string;
    metadata?: Record<string, unknown>;
}): Promise<void> {
    if (!Number.isInteger(args.amountCents) || args.amountCents <= 0) return;

    const platformUserId = await getPlatformUserId();
    await creditUser({
        userId: platformUserId,
        amountCents: args.amountCents,
        refType: args.refType,
        refId: args.refId,
        description: args.description ?? "Comision platformă",
        metadata: args.metadata,
    });
}
