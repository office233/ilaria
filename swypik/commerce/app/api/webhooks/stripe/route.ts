import { NextResponse } from "next/server";
import { getStripe } from "@/lib/stripe/checkout";
import { dbQuery } from "@/lib/db";
import { logCheckoutEvent } from "@/lib/security/audit-log";
import { getClientIP } from "@/lib/security/rate-limit";
import type Stripe from "stripe";

import { handleCheckoutCompletedEvent } from "./_handlers/checkout";
import { handlePaymentIntentSucceededEvent, handlePaymentIntentFailed } from "./_handlers/payments";
import { handleChargeRefunded, handleIntentDead } from "./_handlers/refunds";
import { handleAccountUpdated } from "./_handlers/connect";
import { handleDisputeEvent } from "./_handlers/disputes";
import { CREATOR_UNLOCK_KINDS, handleCreatorUnlockPaymentSucceeded } from "./_handlers/creator-unlocks";
import { handlePaymentIntentCapturable } from "./_handlers/stays";
import { logger } from "@/lib/logger";
export const dynamic = "force-dynamic";

type EventHandler = (event: Stripe.Event) => Promise<void>;

/** Movies/Music (deblocare cu cardul, RON) au propriul `metadata.kind` — le rutăm înaintea comenzilor obișnuite. */
async function handlePaymentIntentSucceededRouted(event: Stripe.Event): Promise<void> {
  const intent = event.data.object as Stripe.PaymentIntent;
  const kind = intent.metadata?.kind;
  if (kind && CREATOR_UNLOCK_KINDS.has(kind)) {
    return handleCreatorUnlockPaymentSucceeded(event);
  }
  return handlePaymentIntentSucceededEvent(event);
}

const HANDLERS: Record<string, EventHandler> = {
  "checkout.session.completed": handleCheckoutCompletedEvent,
  "checkout.session.async_payment_succeeded": handleCheckoutCompletedEvent,
  "payment_intent.succeeded": handlePaymentIntentSucceededRouted,
  "payment_intent.payment_failed": handlePaymentIntentFailed,
  "payment_intent.amount_capturable_updated": handlePaymentIntentCapturable,
  "account.updated": handleAccountUpdated,
  "charge.refunded": handleChargeRefunded,
  "payment_intent.canceled": handleIntentDead,
  "checkout.session.async_payment_failed": handleIntentDead,
  "checkout.session.expired": handleIntentDead,
  "charge.dispute.created": handleDisputeEvent,
  "charge.dispute.updated": handleDisputeEvent,
  "charge.dispute.closed": handleDisputeEvent,
  "charge.dispute.funds_withdrawn": handleDisputeEvent,
  "charge.dispute.funds_reinstated": handleDisputeEvent,
};

const MAX_WEBHOOK_BYTES = 1024 * 1024;
class WebhookBodyTooLargeError extends Error {}

async function getRawBody(req: Request): Promise<Buffer> {
  const declaredSize = Number(req.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_WEBHOOK_BYTES) {
    throw new WebhookBodyTooLargeError();
  }
  const chunks: Uint8Array[] = [];
  const reader = req.body?.getReader();
  if (!reader) throw new Error("No body");
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        bytes += value.byteLength;
        if (bytes > MAX_WEBHOOK_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new WebhookBodyTooLargeError();
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

export async function POST(req: Request) {
  // 2026-08-17 (audit): cele 6 `webhook_fail` din `checkout_audit_log` aveau
  // `client_ip` gol, așa că nu s-a putut stabili cine trimitea cereri cu
  // semnătură invalidă. Folosim `getClientIP` — același helper ca restul
  // rutelor (43 de fișiere) — nu o a treia variantă locală.
  //
  // NU citim `cf-connecting-ip`: e un header pe care oricine îl poate
  // trimite direct către origine, iar `getClientIP` îl ignoră deliberat
  // (vezi comentariul din lib/security/rate-limit.ts). Dovadă că helperul
  // funcționează prin tunelul actual: `checkout_audit_log` conține
  // 92.180.72.182 (IP public real) scris de app/api/checkout/route.ts:159,
  // care folosește exact acest helper.
  const clientIp = getClientIP(req);
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    logger.error("[Stripe Webhook] STRIPE_WEBHOOK_SECRET is not configured");
    await logCheckoutEvent("webhook_fail", {
      clientIp,
      error: "STRIPE_WEBHOOK_SECRET is not configured",
      payload: { stage: "configuration" },
    });
    return NextResponse.json({ error: "Webhook not configured" }, { status: 500 });
  }

  let event: Stripe.Event;

  try {
    const signature = req.headers.get("stripe-signature");
    if (!signature) {
      await logCheckoutEvent("webhook_fail", {
        clientIp,
        error: "Missing Stripe signature",
        payload: { stage: "signature" },
      });
      return NextResponse.json({ error: "Missing signature" }, { status: 400 });
    }
    const rawBody = await getRawBody(req);
    event = getStripe().webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err: unknown) {
    if (err instanceof WebhookBodyTooLargeError) {
      return NextResponse.json({ error: "Payload too large" }, { status: 413 });
    }
    logger.error({ err }, "[Stripe Webhook] Signature verification failed");
    await logCheckoutEvent("webhook_fail", {
      clientIp,
      error: (err instanceof Error && err.message) || "Signature verification failed",
      payload: { stage: "signature" },
    });
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  // Idempotency: atomic claim against processed_stripe_events. Stripe retries
  // events; without this guard fulfillment, emails, payouts and stock
  // decrements would all rerun. We INSERT ... ON CONFLICT DO NOTHING and
  // require a returned row before proceeding.
  try {
    const { rows: claimRows } = await dbQuery<{ event_id: string }>(
      `INSERT INTO processed_stripe_events (event_id, event_type)
       VALUES ($1, $2)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [event.id, event.type]
    );
    if (claimRows.length === 0) {
      logger.info(`[Stripe Webhook] duplicate stripe event, skipping: ${event.id} (${event.type})`);
      return NextResponse.json({ received: true, duplicate: true });
    }
  } catch (err: unknown) {
    logger.error({ err }, `[Stripe Webhook] idempotency claim failed for ${event.id}`);
    // Returning 500 lets Stripe retry; do NOT proceed without a successful claim.
    return NextResponse.json({ error: "Idempotency claim failed" }, { status: 500 });
  }

  try {
    const handler = HANDLERS[event.type];
    if (handler) {
      await handler(event);
    } else {
      logger.info({ event_type: event.type, event_id: event.id }, "[Stripe Webhook] unhandled event");
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ msg }, "[Stripe Webhook] Handler failed");
    // CRITIC (audit 2026-08-25): claim-ul de idempotenta a fost deja inserat.
    // Daca handler-ul esueaza (ex. listLineItems da timeout) si lasam randul,
    // retry-ul lui Stripe e tratat ca DUPLICAT si evenimentul se pierde
    // definitiv — plata reusita, comanda nefinalizata. Eliberam claim-ul ca
    // retry-ul sa poata reintra. (Handler-ele trebuie sa fie idempotente
    // intern, ceea ce sunt — scriu cu ON CONFLICT / guards de stare.)
    await dbQuery(
      `DELETE FROM processed_stripe_events WHERE event_id = $1`,
      [event.id],
    ).catch((delErr) =>
      logger.error({ err: delErr, eventId: event.id },
        "[Stripe Webhook] failed to release idempotency claim — event may be stuck"),
    );
    await logCheckoutEvent("webhook_fail", {
      error: msg || "Webhook handler failed",
      payload: { stage: "handler", eventType: event.type, eventId: event.id },
    });
    return NextResponse.json({ error: "Webhook handler failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
