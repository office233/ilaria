/**
 * Rambursarea unei comenzi Swypik Food anulate/refuzate.
 *
 *  - card_online plătit            → Stripe refund (idempotent pe comandă)
 *  - card_online încă neconfirmat  → PaymentIntent anulat (nu mai poate fi plătit)
 *  - PaymentIntent „processing"    → refund_status='pending'; webhook-ul de
 *    succes vede comanda anulată și reapelează funcția (eats-stripe.ts)
 *  - cash / card la curier         → nimic de returnat ('not_required')
 *  - comandă deja decontată        → intrările din wallet ledger (curier +
 *    comision platformă) se inversează cu creditUser/debitUser (idempotent pe
 *    ref_type '<tip>_reversal')
 *
 * Nu aruncă: orice eșec ajunge în refund_status='failed' + reconciliation_issues,
 * ca anularea în sine să nu fie blocată de Stripe.
 */
import { dbQuery } from "@/lib/db";
import { getStripe } from "@/lib/stripe/checkout";
import { creditUser, debitUser } from "@/lib/wallet/ledger";
import { logger } from "@/lib/logger";

const log = logger.child({ mod: "food/refund" });

export type RefundStatus = "not_required" | "pending" | "succeeded" | "failed";
export type RefundOutcome = { status: RefundStatus; refundId?: string; amountCents?: number; ledgerReversed: number };

type OrderRow = {
  id: string;
  status: string;
  payment_method: string;
  payment_status: string;
  payment_intent_id: string | null;
  refund_status: string;
  settled_at: string | null;
};

const CANCELABLE_PI = new Set(["requires_payment_method", "requires_confirmation", "requires_action", "requires_capture"]);
const REVERSIBLE_REF_TYPES = ["order", "commission_order"] as const;

async function reportIssue(orderId: string, details: Record<string, unknown>): Promise<void> {
  try {
    await dbQuery(
      `INSERT INTO reconciliation_issues (kind, ref_id, details) VALUES ('local_order_refund', $1, $2::jsonb)
       ON CONFLICT DO NOTHING`,
      [orderId, JSON.stringify(details)],
    );
  } catch (err) {
    log.error({ err, orderId }, "reconciliation issue write failed");
  }
}

async function setRefundState(orderId: string, status: RefundStatus, extra: { refundId?: string; amountCents?: number; paymentStatus?: string } = {}): Promise<void> {
  await dbQuery(
    `UPDATE local_orders
        SET refund_status = $2,
            refund_id = COALESCE($3, refund_id),
            refund_amount_cents = COALESCE($4, refund_amount_cents),
            refunded_at = CASE WHEN $2 = 'succeeded' THEN COALESCE(refunded_at, now()) ELSE refunded_at END,
            payment_status = COALESCE($5, payment_status),
            updated_at = now()
      WHERE id = $1`,
    [orderId, status, extra.refundId ?? null, extra.amountCents ?? null, extra.paymentStatus ?? null],
  );
}

/** Inversează decontarea din ledger (dacă a existat). Întoarce numărul de intrări inversate. */
export async function reverseLocalOrderSettlement(orderId: string): Promise<number> {
  const { rows } = await dbQuery<{ user_id: string; kind: "credit" | "debit"; amount_cents: string | number; ref_type: string }>(
    `SELECT user_id, kind, amount_cents, ref_type FROM wallet_ledger_entries
      WHERE ref_id = $1 AND ref_type = ANY($2::text[])`,
    [orderId, REVERSIBLE_REF_TYPES],
  );
  let n = 0;
  for (const e of rows) {
    const args = {
      userId: e.user_id,
      amountCents: Number(e.amount_cents),
      refType: `${e.ref_type}_reversal`,
      refId: orderId,
      description: `Stornare comandă anulată #${orderId.slice(0, 8)}`,
      metadata: { reversed_kind: e.kind },
      allowNegative: true,
    };
    const r = e.kind === "credit" ? await debitUser(args) : await creditUser(args);
    if (!r.alreadyApplied) n++;
  }
  if (rows.length) {
    // Partea merchantului (merchant_settlements) nu are stare „anulat" — o semnalăm.
    await reportIssue(orderId, { reason: "settled_order_cancelled", reversed_entries: rows.length });
  }
  return n;
}

export async function refundLocalOrder(orderId: string, reason: string): Promise<RefundOutcome> {
  const { rows } = await dbQuery<OrderRow>(
    `SELECT id, status, payment_method, payment_status, payment_intent_id, refund_status, settled_at::text
       FROM local_orders WHERE id = $1`,
    [orderId],
  );
  const o = rows[0];
  if (!o || !["cancelled", "rejected"].includes(o.status)) return { status: "not_required", ledgerReversed: 0 };
  if (o.refund_status === "succeeded") return { status: "succeeded", ledgerReversed: 0 };

  let ledgerReversed = 0;
  try {
    if (o.settled_at) ledgerReversed = await reverseLocalOrderSettlement(o.id);
  } catch (err) {
    log.error({ err, orderId }, "ledger reversal failed");
    await reportIssue(orderId, { reason: "ledger_reversal_failed" });
  }

  if (o.payment_method !== "card_online" || !o.payment_intent_id) {
    await setRefundState(o.id, "not_required");
    return { status: "not_required", ledgerReversed };
  }

  try {
    const stripe = getStripe();
    const pi = await stripe.paymentIntents.retrieve(o.payment_intent_id);
    if (pi.status === "succeeded") {
      const refund = await stripe.refunds.create(
        { payment_intent: pi.id, metadata: { kind: "local_order", local_order_id: o.id, reason } },
        { idempotencyKey: `local_order:${o.id}:refund` },
      );
      const ok = refund.status === "succeeded";
      const status: RefundStatus = ok ? "succeeded" : refund.status === "failed" ? "failed" : "pending";
      await setRefundState(o.id, status, {
        refundId: refund.id,
        amountCents: refund.amount,
        paymentStatus: ok ? "refunded" : undefined,
      });
      log.info({ orderId, refund: refund.id, status }, "local order refunded");
      return { status, refundId: refund.id, amountCents: refund.amount, ledgerReversed };
    }
    if (CANCELABLE_PI.has(pi.status)) {
      await stripe.paymentIntents.cancel(pi.id);
      await setRefundState(o.id, "not_required", { paymentStatus: o.payment_status === "paid" ? undefined : "failed" });
      return { status: "not_required", ledgerReversed };
    }
    if (pi.status === "processing") {
      await setRefundState(o.id, "pending");
      return { status: "pending", ledgerReversed };
    }
    await setRefundState(o.id, "not_required");
    return { status: "not_required", ledgerReversed };
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    log.error({ err, orderId }, "stripe refund failed");
    await setRefundState(o.id, "failed");
    await reportIssue(orderId, { reason: "stripe_refund_failed", code: typeof code === "string" ? code : null });
    return { status: "failed", ledgerReversed };
  }
}
