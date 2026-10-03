import { NextResponse } from "next/server";
import { claimDelivery, handleRtkEvent, releaseDelivery, type RtkWebhookEvent } from "@/lib/messenger/call-webhook";
import { logger } from "@/lib/logger";
import { isRtkConfigured } from "@/lib/realtime/config";
import { verifyRtkSignature } from "@/lib/realtime/rtk-webhook";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 64 * 1024;

/**
 * POST /api/messenger/calls/webhook — webhook Cloudflare RealtimeKit
 * (meeting.started/ended, meeting.participantJoined/Left). Semnătura
 * `rtk-signature` (RSA-SHA256 peste corpul brut) e verificată ÎNAINTE de orice
 * citire/scriere în DB; livrările duplicate (`rtk-uuid`) sunt ignorate.
 * 4xx = RealtimeKit nu reîncearcă; 5xx = reîncearcă.
 */
export async function POST(req: Request) {
  if (!isRtkConfigured()) return NextResponse.json({ error: "calls_unavailable" }, { status: 503 });

  const raw = await req.text();
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  if (!(await verifyRtkSignature(raw, req.headers.get("rtk-signature")))) {
    logger.warn("[calls/webhook] invalid signature");
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  let event: RtkWebhookEvent;
  try {
    event = JSON.parse(raw) as RtkWebhookEvent;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const deliveryId = req.headers.get("rtk-uuid");
  try {
    if (!(await claimDelivery(deliveryId, event.event ?? "unknown"))) {
      return NextResponse.json({ ok: true, outcome: "duplicate" });
    }
    const outcome = await handleRtkEvent(event);
    return NextResponse.json({ ok: true, outcome });
  } catch (err) {
    logger.error({ err, event: event.event }, "[calls/webhook] handler failed");
    await releaseDelivery(deliveryId).catch(() => undefined);
    return NextResponse.json({ error: "handler_failed" }, { status: 500 });
  }
}
