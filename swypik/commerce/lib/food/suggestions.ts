/**
 * „Sugerează proprietarului”: un client semnalează că vrea un restaurant
 * nerevendicat pe Swypik. Un vot per (restaurant, user sau IP) — cheia e
 * hash-uită, IP-ul nu se stochează în clar. Contorul denormalizat
 * local_merchants.suggestion_count ordonează lista „Nu încă pe Swypik”.
 */
import crypto from "crypto";
import { dbQuery, withTransaction } from "@/lib/db";

export function suggesterKey(userId: string | null, ip: string | null): string | null {
  const raw = userId ? `u:${userId}` : ip ? `ip:${ip}` : null;
  return raw ? crypto.createHash("sha256").update(raw).digest("hex") : null;
}

export type SuggestResult =
  | { ok: true; counted: boolean; count: number }
  | { ok: false; code: "not_found" | "not_claimable" };

export async function suggestMerchant(merchantId: string, key: string, userId: string | null): Promise<SuggestResult> {
  const { rows } = await dbQuery<{ listing_mode: string; seller_id: string | null; status: string; suggestion_count: number }>(
    `SELECT listing_mode, seller_id, status, suggestion_count FROM local_merchants WHERE id = $1`,
    [merchantId],
  );
  const m = rows[0];
  if (!m || m.status !== "active") return { ok: false, code: "not_found" };
  if (m.listing_mode === "orderable" || m.seller_id) return { ok: false, code: "not_claimable" };

  return withTransaction(async (q) => {
    const ins = await q(
      `INSERT INTO merchant_suggestions (merchant_id, suggester_key, user_id)
       VALUES ($1, $2, $3) ON CONFLICT (merchant_id, suggester_key) DO NOTHING RETURNING id`,
      [merchantId, key, userId],
    );
    if (!ins.rows[0]) return { ok: true as const, counted: false, count: Number(m.suggestion_count ?? 0) };
    const upd = await q(
      `UPDATE local_merchants SET suggestion_count = suggestion_count + 1 WHERE id = $1 RETURNING suggestion_count`,
      [merchantId],
    );
    return { ok: true as const, counted: true, count: Number((upd.rows[0] as { suggestion_count: number }).suggestion_count) };
  });
}
