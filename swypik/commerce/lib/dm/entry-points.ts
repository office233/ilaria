/**
 * Puncte de intrare în Messenger: profil, vânzător (produs/magazin), comandă
 * shop, comandă food. Paginile NU cunosc user id-ul vânzătorului — trimit
 * entitatea (`/messages/new?seller=<id>`) și serverul rezolvă interlocutorul,
 * cu verificarea că viewer-ul are dreptul (cumpărătorul/vânzătorul comenzii).
 */
import { dbQuery } from "@/lib/db";
import { isUuidParam } from "@/lib/validation/params";
import { DM_ENTRY_KINDS, type DmEntry, type DmEntryKind } from "./links";

export { dmEntryHref, type DmEntry } from "./links";

/** Prima intrare validă din query (uuid obligatoriu), altfel null. */
export function parseDmEntry(params: Record<string, string | string[] | undefined>): DmEntry | null {
  for (const kind of DM_ENTRY_KINDS) {
    const raw = params[kind];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value && isUuidParam(value.trim())) return { kind, id: value.trim() };
  }
  return null;
}

type PeerRow = { peer: string | null };

const QUERIES: Record<DmEntryKind, string> = {
  user: `SELECT id::text AS peer FROM users WHERE id = $1 AND $2::uuid IS NOT NULL LIMIT 1`,
  // sellers.id ≠ users.id: butonul vechi trimitea id-ul vânzătorului ca user (audit §2).
  seller: `SELECT user_id::text AS peer FROM sellers
            WHERE id = $1 AND status IN ('approved', 'active') AND user_id IS NOT NULL
              AND $2::uuid IS NOT NULL
            LIMIT 1`,
  // Cumpărătorul scrie vânzătorului; vânzătorul scrie cumpărătorului.
  order: `SELECT (CASE WHEN o.buyer_user_id = $2 THEN s.user_id ELSE o.buyer_user_id END)::text AS peer
            FROM commerce_orders o
            JOIN commerce_order_items oi ON oi.order_id = o.id
            JOIN marketplace_products mp ON mp.id = oi.product_id
            JOIN sellers s ON s.id = mp.seller_id
           WHERE o.id = $1 AND s.user_id IS NOT NULL AND o.buyer_user_id IS NOT NULL
             AND (o.buyer_user_id = $2 OR s.user_id = $2)
           ORDER BY oi.created_at
           LIMIT 1`,
  food_order: `SELECT (CASE WHEN lo.customer_user_id = $2 THEN s.user_id ELSE lo.customer_user_id END)::text AS peer
                 FROM local_orders lo
                 JOIN local_merchants lm ON lm.id = lo.merchant_id
                 JOIN sellers s ON s.id = lm.seller_id
                WHERE lo.id = $1 AND s.user_id IS NOT NULL AND lo.customer_user_id IS NOT NULL
                  AND (lo.customer_user_id = $2 OR s.user_id = $2)
                LIMIT 1`,
};

/**
 * User id-ul interlocutorului pentru o intrare, sau null dacă entitatea nu
 * există, nu are un cont de contactat sau viewer-ul nu are acces la ea.
 */
export async function resolveDmPeer(entry: DmEntry, viewerId: string): Promise<string | null> {
  if (!isUuidParam(entry.id)) return null;
  const { rows } = await dbQuery<PeerRow>(QUERIES[entry.kind], [entry.id, viewerId]);
  const peer = rows[0]?.peer ?? null;
  return peer && peer !== viewerId ? peer : null;
}
