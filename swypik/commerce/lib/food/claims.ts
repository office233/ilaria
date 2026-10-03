/**
 * Revendicarea unui profil de restaurant nerevendicat (merchant_claim_requests).
 *
 * Flux: proprietarul (logat) trimite cererea → adminul o aprobă în
 * /admin/merchant-claims → sellerul proprietarului e găsit/legat/creat,
 * comerciantul primește seller_id + listing_mode='orderable' (+ status
 * 'active' dacă era în așteptare), iar celelalte cereri în așteptare pentru
 * același restaurant sunt respinse automat.
 */
import { dbQuery, withTransaction } from "@/lib/db";

type TxQuery = Parameters<Parameters<typeof withTransaction>[0]>[0];

export type ClaimInput = {
  merchantId: string;
  userId: string;
  contactName?: string | null;
  contactPhone: string;
  contactEmail?: string | null;
  message?: string | null;
};

export type CreateClaimResult =
  | { ok: true; claimId: string }
  | { ok: false; code: "not_found" | "not_claimable" | "claim_pending" };

export async function createClaim(input: ClaimInput): Promise<CreateClaimResult> {
  const { rows } = await dbQuery<{ id: string; seller_id: string | null; status: string }>(
    `SELECT id, seller_id, status FROM local_merchants WHERE id = $1`,
    [input.merchantId],
  );
  const m = rows[0];
  if (!m || !["active", "pending"].includes(m.status)) return { ok: false, code: "not_found" };
  if (m.seller_id) return { ok: false, code: "not_claimable" };

  const ins = await dbQuery<{ id: string }>(
    `INSERT INTO merchant_claim_requests (merchant_id, user_id, contact_name, contact_phone, contact_email, message)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (merchant_id, user_id) WHERE status = 'pending' DO NOTHING
     RETURNING id`,
    [input.merchantId, input.userId, input.contactName ?? null, input.contactPhone, input.contactEmail ?? null, input.message ?? null],
  );
  if (!ins.rows[0]) return { ok: false, code: "claim_pending" };
  return { ok: true, claimId: ins.rows[0].id };
}

export type ReviewFailure =
  | "not_found" | "not_pending" | "already_claimed" | "claimant_no_email" | "seller_email_conflict" | "seller_not_active";
export type ApproveResult = { ok: true; sellerId: string; merchantId: string; createdSeller: boolean } | { ok: false; code: ReviewFailure };

type LockedClaim = {
  id: string;
  status: string;
  merchant_id: string;
  user_id: string;
  contact_phone: string;
  contact_email: string | null;
  merchant_name: string;
  merchant_seller_id: string | null;
  user_email: string | null;
};

/** Găsește/leagă/creează sellerul proprietarului. */
async function resolveSeller(q: TxQuery, c: LockedClaim): Promise<{ id: string; created: boolean } | ReviewFailure> {
  const byUser = await q(`SELECT id, status FROM sellers WHERE user_id = $1 LIMIT 1 FOR UPDATE`, [c.user_id]);
  let seller = byUser.rows[0] as { id: string; status: string; user_id?: string | null } | undefined;
  const email = (c.user_email || c.contact_email || "").trim().toLowerCase();

  if (!seller && email) {
    const byEmail = await q(`SELECT id, status, user_id FROM sellers WHERE lower(email) = $1 LIMIT 1 FOR UPDATE`, [email]);
    const s = byEmail.rows[0] as { id: string; status: string; user_id: string | null } | undefined;
    if (s && s.user_id && s.user_id !== c.user_id) return "seller_email_conflict";
    if (s) {
      await q(`UPDATE sellers SET user_id = $2, updated_at = now() WHERE id = $1`, [s.id, c.user_id]);
      seller = s;
    }
  }

  if (seller) {
    if (seller.status === "suspended" || seller.status === "rejected") return "seller_not_active";
    // Verificarea restaurantului de către admin validează și contul de seller.
    if (seller.status === "pending") {
      await q(`UPDATE sellers SET status = 'approved', updated_at = now() WHERE id = $1`, [seller.id]);
    }
    return { id: seller.id, created: false };
  }

  if (!email) return "claimant_no_email";
  const created = await q(
    `INSERT INTO sellers (name, email, phone, status, user_id, business_details)
     VALUES ($1, $2, $3, 'active', $4, jsonb_build_object('source', 'merchant_claim', 'merchant_id', $5::text))
     RETURNING id`,
    [c.merchant_name, email, c.contact_phone, c.user_id, c.merchant_id],
  );
  return { id: (created.rows[0] as { id: string }).id, created: true };
}

export async function approveClaim(claimId: string, note: string | null): Promise<ApproveResult> {
  return withTransaction(async (q) => {
    const { rows } = await q(
      `SELECT c.id, c.status, c.merchant_id, c.user_id, c.contact_phone, c.contact_email,
              m.name AS merchant_name, m.seller_id AS merchant_seller_id, u.email AS user_email
         FROM merchant_claim_requests c
         JOIN local_merchants m ON m.id = c.merchant_id
         LEFT JOIN users u ON u.id = c.user_id
        WHERE c.id = $1
        FOR UPDATE OF c, m`,
      [claimId],
    );
    const c = rows[0] as LockedClaim | undefined;
    if (!c) return { ok: false as const, code: "not_found" as const };
    if (c.status !== "pending") return { ok: false as const, code: "not_pending" as const };
    if (c.merchant_seller_id) return { ok: false as const, code: "already_claimed" as const };

    const seller = await resolveSeller(q, c);
    if (typeof seller === "string") return { ok: false as const, code: seller };

    await q(
      `UPDATE local_merchants
          SET seller_id = $2, listing_mode = 'orderable',
              status = CASE WHEN status = 'pending' THEN 'active' ELSE status END,
              updated_at = now()
        WHERE id = $1`,
      [c.merchant_id, seller.id],
    );
    await q(
      `UPDATE merchant_claim_requests
          SET status = 'approved', reviewed_at = now(), review_note = $2, seller_id = $3, updated_at = now()
        WHERE id = $1`,
      [c.id, note, seller.id],
    );
    await q(
      `UPDATE merchant_claim_requests
          SET status = 'rejected', reviewed_at = now(), review_note = 'superseded', updated_at = now()
        WHERE merchant_id = $1 AND status = 'pending' AND id <> $2`,
      [c.merchant_id, c.id],
    );
    return { ok: true as const, sellerId: seller.id, merchantId: c.merchant_id, createdSeller: seller.created };
  });
}

export async function rejectClaim(claimId: string, note: string | null): Promise<{ ok: boolean; code?: "not_found" }> {
  const { rowCount } = await dbQuery(
    `UPDATE merchant_claim_requests
        SET status = 'rejected', reviewed_at = now(), review_note = $2, updated_at = now()
      WHERE id = $1 AND status = 'pending'`,
    [claimId, note],
  );
  return rowCount ? { ok: true } : { ok: false, code: "not_found" };
}
