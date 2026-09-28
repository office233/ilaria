/**
 * Aplică o tranziție de status pe o comandă Food, atomic (SELECT … FOR UPDATE),
 * validată de mașina de stări pură din ./order-status.ts. Efectele secundare
 * (refund, dispatch, decontare, push) sunt în ./transition-effects.ts.
 */
import { withTransaction } from "@/lib/db";
import { releaseJobForOrder } from "@/lib/dispatch/lifecycle";
import { checkTransition, STATUS_TIMESTAMP_COL, type OrderActor, type OrderStatus } from "./order-status";

export type LockedOrder = {
  id: string;
  status: string;
  courier_id: string | null;
  customer_user_id: string | null;
  guest_token_hash: string | null;
  order_number: string;
  payment_method: string;
  payment_status: string;
  seller_id: string | null;
  merchant_name: string;
};

export type TransitionFailure = "not_found" | "forbidden" | "invalid_transition" | "unpaid_card";

export type TransitionResult =
  | {
      ok: true;
      order: { id: string; order_number: string; status: OrderStatus; updated_at: string };
      previousStatus: string;
      customerUserId: string | null;
      merchantName: string;
      courierId: string | null;
    }
  | { ok: false; code: TransitionFailure; http: number; from?: string };

const CANCELLED_BY: Record<OrderActor, string> = {
  customer: "customer",
  merchant: "merchant",
  courier: "system",
  admin: "admin",
  system: "system",
};

export async function transitionOrder(args: {
  orderId: string;
  to: OrderStatus;
  actor: OrderActor;
  /** Verificarea de ownership pe rândul blocat (seller / curier / client / token). */
  authorize: (o: LockedOrder) => boolean;
  reason?: string | null;
}): Promise<TransitionResult> {
  const { orderId, to, actor, authorize } = args;
  return withTransaction(async (q) => {
    const { rows } = await q(
      `SELECT lo.id, lo.status, lo.courier_id, lo.customer_user_id, lo.guest_token_hash, lo.order_number,
              lo.payment_method, lo.payment_status, m.seller_id, m.name AS merchant_name
         FROM local_orders lo JOIN local_merchants m ON m.id = lo.merchant_id
        WHERE lo.id = $1 FOR UPDATE OF lo`,
      [orderId],
    );
    const o = rows[0] as LockedOrder | undefined;
    if (!o) return { ok: false as const, code: "not_found" as const, http: 404 };
    if (!authorize(o)) return { ok: false as const, code: "forbidden" as const, http: 403 };

    const check = checkTransition(o.status, to, actor);
    if (!check.ok) {
      const http = check.code === "forbidden_actor" ? 403 : 409;
      const code = check.code === "forbidden_actor" ? "forbidden" : "invalid_transition";
      return { ok: false as const, code, http, from: o.status };
    }

    // O comandă card_online neconfirmată nu intră în producție (audit 2026-09).
    if (to === "accepted" && o.payment_method === "card_online" && o.payment_status !== "paid") {
      return { ok: false as const, code: "unpaid_card" as const, http: 409 };
    }

    const tsCol = STATUS_TIMESTAMP_COL[to];
    const isCancel = to === "cancelled" || to === "rejected";
    const { rows: res } = await q(
      `UPDATE local_orders
          SET status = $2,
              cancel_reason = COALESCE($3, cancel_reason),
              cancelled_by = CASE WHEN $4::text IS NULL THEN cancelled_by ELSE $4 END,
              ${tsCol ? `${tsCol} = now(),` : ""}
              updated_at = now()
        WHERE id = $1
        RETURNING id, order_number, status, updated_at`,
      [orderId, to, args.reason ?? null, isCancel ? CANCELLED_BY[actor] : null],
    );

    // Eliberează jobul de dispatch în aceeași tranzacție (API-ul public lib/dispatch/lifecycle):
    // altfel curierul rămânea „ocupat” după livrare/anulare.
    if (to === "delivered") await releaseJobForOrder(q, orderId, "completed");
    else if (isCancel) await releaseJobForOrder(q, orderId, "cancelled");

    if (to === "delivered" && o.courier_id) {
      await q(
        `UPDATE couriers SET completed_deliveries = completed_deliveries + 1, updated_at = now() WHERE id = $1`,
        [o.courier_id],
      );
    }

    return {
      ok: true as const,
      order: res[0] as { id: string; order_number: string; status: OrderStatus; updated_at: string },
      previousStatus: o.status,
      customerUserId: o.customer_user_id,
      merchantName: o.merchant_name,
      courierId: o.courier_id,
    };
  });
}
