/**
 * Plata cu cardul a comenzilor Food — hold la plasare, încasare la acceptare
 * (audit food-go #7). PaymentIntent-ul e creat cu capture_method=manual
 * (lib/payments/eats-stripe.ts).
 *
 *  - syncLocalOrderAuthorization: după confirmPayment în client (și din
 *    watchdog) verifică la Stripe că hold-ul există → payment_authorized_at;
 *  - captureLocalOrderPayment: la acceptarea restaurantului încasează hold-ul
 *    → payment_status='paid'. Fără hold valid, acceptarea e refuzată.
 *
 * Stripe neconfigurat (chei placeholder) → „card_unavailable", nu succes fals.
 */
import { dbQuery } from "@/lib/db";
import { getStripe } from "@/lib/stripe/checkout";
import { logger } from "@/lib/logger";

const log = logger.child({ mod: "food/card-payment" });

type CardOrder = {
  id: string;
  status: string;
  payment_method: string;
  payment_status: string;
  payment_intent_id: string | null;
  total_cents: number;
};

async function loadCardOrder(orderId: string): Promise<CardOrder | null> {
  const { rows } = await dbQuery<CardOrder>(
    `SELECT id, status, payment_method, payment_status, payment_intent_id, total_cents::int AS total_cents
       FROM local_orders WHERE id = $1`,
    [orderId],
  );
  return rows[0] ?? null;
}

async function markPaid(orderId: string, piId: string): Promise<void> {
  await dbQuery(
    `UPDATE local_orders
        SET payment_status = 'paid', payment_intent_id = COALESCE(payment_intent_id, $2),
            payment_authorized_at = COALESCE(payment_authorized_at, now()), updated_at = now()
      WHERE id = $1 AND payment_status NOT IN ('paid', 'refunded')`,
    [orderId, piId],
  );
}

export type AuthorizationState = "authorized" | "paid" | "pending" | "not_card" | "card_unavailable";

/** Verifică hold-ul la Stripe; idempotent. */
export async function syncLocalOrderAuthorization(orderId: string): Promise<AuthorizationState> {
  const o = await loadCardOrder(orderId);
  if (!o || o.payment_method !== "card_online") return "not_card";
  if (o.payment_status === "paid") return "paid";
  if (!o.payment_intent_id) return "pending";
  let pi;
  try {
    pi = await getStripe().paymentIntents.retrieve(o.payment_intent_id);
  } catch (err) {
    log.warn({ err, orderId }, "stripe retrieve failed");
    return "card_unavailable";
  }
  if (pi.metadata?.local_order_id !== o.id) return "pending";
  if (pi.status === "succeeded") {
    await markPaid(o.id, pi.id);
    return "paid";
  }
  if (pi.status === "requires_capture" && pi.amount_capturable >= o.total_cents) {
    await dbQuery(
      `UPDATE local_orders SET payment_authorized_at = COALESCE(payment_authorized_at, now()), updated_at = now()
        WHERE id = $1`,
      [o.id],
    );
    return "authorized";
  }
  return "pending";
}

export type CaptureResult = { ok: true } | { ok: false; code: "unpaid_card" | "card_unavailable" };

/**
 * Încasează hold-ul la acceptarea restaurantului. Apelat DOAR după verificarea
 * de ownership + status 'placed' (ruta de status). Idempotent (idempotencyKey).
 */
export async function captureLocalOrderPayment(orderId: string): Promise<CaptureResult> {
  const o = await loadCardOrder(orderId);
  if (!o || o.payment_method !== "card_online") return { ok: true };
  if (o.payment_status === "paid") return { ok: true };
  if (!o.payment_intent_id) return { ok: false, code: "unpaid_card" };
  try {
    const stripe = getStripe();
    const pi = await stripe.paymentIntents.retrieve(o.payment_intent_id);
    if (pi.metadata?.local_order_id !== o.id) return { ok: false, code: "unpaid_card" };
    if (pi.status === "succeeded") {
      await markPaid(o.id, pi.id);
      return { ok: true };
    }
    if (pi.status !== "requires_capture") return { ok: false, code: "unpaid_card" };
    const captured = await stripe.paymentIntents.capture(pi.id, {}, { idempotencyKey: `local_order:${o.id}:capture` });
    if (captured.status !== "succeeded") return { ok: false, code: "unpaid_card" };
    await markPaid(o.id, captured.id);
    log.info({ orderId, pi: pi.id }, "local order captured on accept");
    return { ok: true };
  } catch (err) {
    log.error({ err, orderId }, "capture failed");
    return { ok: false, code: "card_unavailable" };
  }
}
