/**
 * Checkout Audit Logger
 * 
 * Logs checkout events to checkout_audit_log table for:
 * - Security monitoring (who tried to checkout what)
 * - Debugging failed checkouts
 * - Business intelligence (conversion funnel)
 * - Fraud detection patterns
 * 
 * Non-blocking: fire-and-forget, never fails the checkout.
 */

import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";

export type AuditEvent =
  | "checkout_start"
  | "checkout_success"
  | "checkout_fail"
  | "checkout_rate_limited"
  | "checkout_rate_limited_email"
  | "checkout_rate_limited_global"
  | "variant_lookup_fail"
  | "product_not_found"
  | "invalid_price"
  | "jit_create"
  | "jit_reuse"
  | "jit_error"
  | "webhook_order"
  | "webhook_fail";

export async function logCheckoutEvent(
  event: AuditEvent,
  data: {
    productId?: string;
    skuId?: string;
    priceRon?: number;
    clientIp?: string;
    userAgent?: string;
    payload?: Record<string, unknown>;
    error?: string;
  }
): Promise<void> {
  try {
    await dbQuery(
      `INSERT INTO checkout_audit_log (event, pg_id, sku_id, price_ron, client_ip, user_agent, payload, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        event,
        data.productId || null,
        data.skuId || null,
        data.priceRon || null,
        data.clientIp || null,
        data.userAgent?.slice(0, 200) || null,
        data.payload ? JSON.stringify(data.payload) : null,
        data.error?.slice(0, 500) || null,
      ]
    );
  } catch (e) {
    // Non-blocking: never fail the checkout because of logging
    logger.warn({ event, err: e }, "[Audit] Failed to log event");
  }
}
