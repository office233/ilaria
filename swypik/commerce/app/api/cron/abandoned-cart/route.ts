/**
 * Cron Job: Abandoned Cart Recovery Emails
 *
 * Queries checkout_sessions where:
 *   - status != 'completed'
 *   - created_at is between 2h and 48h ago
 *   - metadata->>'recovery_email_sent' IS NULL
 *
 * For each match, sends a branded recovery email and flags the session
 * so it is never re-sent.
 *
 * Auth: CRON_SECRET (Bearer token, header, or query param).
 */

import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import {
  sendAbandonedCartEmail,
  type AbandonedCartItem,
} from "@/lib/email/service";
import { timingSafeEqual } from "crypto";

import { runCron, cronSkippedResponse } from "@/lib/cron/runCron";
import { APP_URL } from "@/lib/app-url";
import { logger } from "@/lib/logger";
export const dynamic = "force-dynamic";

async function handleGET(req: Request) {
  /* ── 1. Authorization ───────────────────────────────────── */
  const authHeader = req.headers.get("authorization");
  const token =
    authHeader?.replace("Bearer ", "") ||
    req.headers.get("x-cron-secret") ||
    req.headers.get("cron-secret") ||
    req.headers.get("CRON_SECRET");

  const expected = process.env.CRON_SECRET;
  if (!expected || !token ||
      Buffer.byteLength(token) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const appUrl =
    APP_URL;

  try {
    const { rows: expiredRows } = await dbQuery(
      `WITH expired_sessions AS (
         UPDATE checkout_sessions cs
            SET status = 'expired',
                metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                  'expired_at', NOW()::text,
                  'expired_event', 'local_checkout_expiry'
                )
          WHERE cs.status IN ('created', 'open')
            AND COALESCE(cs.expires_at, cs.created_at + INTERVAL '24 hours') <= NOW()
          RETURNING cs.id, cs.order_id, cs.provider_session_id
       ), cancelled_orders AS (
         UPDATE commerce_orders co
            SET status = 'cancelled',
                metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                  'cancelled_at', NOW()::text,
                  'cancelled_event', 'local_checkout_expiry'
                )
           FROM expired_sessions es
          WHERE co.id = es.order_id
            AND co.status = 'pending'
            AND NOT EXISTS (
              SELECT 1 FROM payment_transactions pt
               WHERE pt.order_id = co.id AND pt.status = 'succeeded'
            )
          RETURNING co.id
       )
       SELECT
         (SELECT count(*) FROM expired_sessions)::int AS expired_sessions,
         (SELECT count(*) FROM cancelled_orders)::int AS cancelled_orders`
    );
    const expiredSessions = Number(expiredRows[0]?.expired_sessions || 0);
    const cancelledOrders = Number(expiredRows[0]?.cancelled_orders || 0);

    /* ── 2. Query abandoned sessions ──────────────────────── */
    const { rows: abandonedSessions } = await dbQuery(
      `SELECT
         id,
         provider_session_id,
         metadata,
         created_at
       FROM checkout_sessions
       WHERE status IN ('created', 'open')
         AND created_at >= NOW() - INTERVAL '48 hours'
         AND created_at <= NOW() - INTERVAL '2 hours'
         AND (metadata->>'recovery_email_sent') IS NULL`
    );

    logger.info({ cron: "abandoned-cart", count: abandonedSessions.length }, "abandoned sessions found");

    let sent = 0;
    let skipped = 0;

    /* ── 3. Process each session ──────────────────────────── */
    for (const session of abandonedSessions) {
      const meta =
        typeof session.metadata === "string"
          ? JSON.parse(session.metadata)
          : session.metadata;

      // Extract customer email
      const customerEmail: string | undefined =
        meta?.customer_email || meta?.email;

      if (!customerEmail || !customerEmail.includes("@")) {
        logger.warn({ sessionId: session.id }, "[Abandoned Cart] Skipping session: no valid email");
        skipped++;
        continue;
      }

      // Extract cart items from metadata
      const rawItems: any[] = meta?.items || [];
      if (rawItems.length === 0) {
        logger.warn({ sessionId: session.id }, "[Abandoned Cart] Skipping session: no items in metadata");
        skipped++;
        continue;
      }

      const cartItems: AbandonedCartItem[] = rawItems.map((item: any) => ({
        title: item.title || "Produs",
        price:
          item.unit_amount_cents != null
            ? Number(item.unit_amount_cents) / 100
            : Number(item.price) || 0,
        image: item.image || undefined,
        quantity: item.quantity || 1,
      }));

      // Build a checkout URL the customer can resume from
      const checkoutUrl = `${appUrl}/checkout?recover=${session.provider_session_id || session.id}`;

      try {
        const ok = await sendAbandonedCartEmail(
          customerEmail,
          cartItems,
          checkoutUrl,
        );

        if (ok) {
          // Mark session so we never re-send
          await dbQuery(
            `UPDATE checkout_sessions
             SET metadata = jsonb_set(
               COALESCE(metadata, '{}'::jsonb),
               '{recovery_email_sent}',
               $1::jsonb
             )
             WHERE id = $2`,
            [JSON.stringify(true), session.id],
          );
          sent++;
          logger.info({ cron: "abandoned-cart", session_id: session.id }, "recovery email sent");
        } else {
          skipped++;
          logger.warn({ cron: "abandoned-cart", session_id: session.id }, "recovery email send returned false");
        }
      } catch (emailErr: any) {
        skipped++;
        logger.error({ err: emailErr, cron: "abandoned-cart", session_id: session.id }, "recovery email failed");
      }
    }

    logger.info({ cron: "abandoned-cart", sent, skipped, total: abandonedSessions.length }, "abandoned cart cron done");

    return NextResponse.json({
      success: true,
      expiredSessions,
      cancelledOrders,
      sent,
      skipped,
      total: abandonedSessions.length,
    });
  } catch (error: any) {
    logger.error({ err: error }, "[Abandoned Cart Cron Error]:");
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}

export const POST = GET;

export async function GET(req: Request) {
  const res = await runCron("abandoned-cart", () => handleGET(req as any));
  return res ?? cronSkippedResponse("abandoned-cart");
}
