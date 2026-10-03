/**
 * Efectele de după o tranziție de status (după COMMIT), comune rutei de status
 * (restaurant/curier) și rutei de anulare a clientului:
 *   ready      → auto-dispatch (setarea merchantului)
 *   delivered  → decontare în wallet ledger (idempotentă)
 *   cancelled/rejected → refund Stripe / anulare PaymentIntent / stornare ledger
 *   picked_up/delivering/delivered/cancelled → eveniment pe stream-ul de dispatch
 *   orice      → push către client, în limba lui
 * Integrarea cu dispatch-ul se face DOAR prin API-ul public al lib/dispatch.
 */
import { logger } from "@/lib/logger";
import { maybeAutoDispatch } from "@/lib/dispatch/auto";
import { getJobForOrder, publishJobEvent } from "@/lib/dispatch/engine";
import { settleLocalOrder } from "@/lib/payments/mobility";
import { refundLocalOrder, type RefundOutcome } from "./refund";
import { notifyCustomerOrderStatus } from "./notify";

const STREAM_STATUSES = new Set(["picked_up", "delivering", "delivered", "cancelled", "rejected"]);

export async function runTransitionEffects(args: {
  orderId: string;
  status: string;
  customerUserId: string | null;
  merchantName: string;
  reason?: string | null;
  /** false când clientul însuși a declanșat tranziția (anulare). */
  notifyCustomer?: boolean;
}): Promise<{ refund: RefundOutcome | null }> {
  const { orderId, status } = args;
  let refund: RefundOutcome | null = null;

  if (status === "ready") {
    try {
      await maybeAutoDispatch(orderId, "ready");
    } catch (err) {
      logger.error({ err, orderId }, "[food/effects] auto-dispatch failed");
    }
  }

  if (status === "delivered") {
    try {
      await settleLocalOrder(orderId);
    } catch (err) {
      logger.error({ err, orderId }, "[food/effects] settlement failed");
    }
  }

  if (status === "cancelled" || status === "rejected") {
    refund = await refundLocalOrder(orderId, args.reason || status);
  }

  if (STREAM_STATUSES.has(status)) {
    try {
      const job = await getJobForOrder(orderId);
      if (job) await publishJobEvent(job.id, { type: "status", status });
    } catch (err) {
      logger.warn({ err, orderId }, "[food/effects] dispatch stream publish failed");
    }
  }

  if (args.notifyCustomer === false) return { refund };
  await notifyCustomerOrderStatus({
    orderId,
    customerUserId: args.customerUserId,
    merchantName: args.merchantName,
    status,
    refunded: refund?.status === "succeeded" || refund?.status === "pending",
  });

  return { refund };
}
