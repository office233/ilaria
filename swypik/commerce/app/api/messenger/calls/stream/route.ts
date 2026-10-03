import { NextResponse } from "next/server";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { getAccountUserId } from "@/lib/social/session";
import { rateLimit } from "@/lib/security/rate-limit";
import { createSseResponse } from "@/lib/realtime/sse";
import { listIncomingCalls } from "@/lib/messenger/calls";
import { callUserChannel, type CallRingEvent } from "@/lib/messenger/call-ring";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/messenger/calls/stream — SSE global pentru apelurile primite
 * (montat în tot app-ul de GlobalCallHost). La conectare trimite apelurile
 * care sună deja; apoi `event: ring` / `event: stop` din Redis (call:user:<id>).
 * Un `ring` e urmat de lista proaspătă, ca payload-ul Redis să nu conțină date personale.
 */
export async function GET(req: Request) {
  if (!isEnabled("messenger")) return frozenResponse("messenger");
  const userId = await getAccountUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const rl = await rateLimit("messengerCallsStream", userId, { limit: 20, window: 60 });
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  return createSseResponse({
    logTag: "messenger/calls",
    channels: [callUserChannel(userId)],
    signal: req.signal,
    onOpen: async (send) => send({ calls: await listIncomingCalls(userId) }, { event: "calls" }),
    onMessage: (_channel, raw, send) => {
      let ev: CallRingEvent;
      try {
        ev = JSON.parse(raw) as CallRingEvent;
      } catch {
        return;
      }
      if (ev.kind === "stop") {
        send({ callId: ev.callId }, { event: "stop" });
        return;
      }
      void listIncomingCalls(userId).then(
        (calls) => send({ calls }, { event: "calls" }),
        () => undefined,
      );
    },
  });
}
