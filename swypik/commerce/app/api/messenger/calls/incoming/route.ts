import { NextResponse } from "next/server";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { getOptionalSocialUserId } from "@/lib/social/session";
import { rateLimit } from "@/lib/security/rate-limit";
import { listIncomingCalls } from "@/lib/messenger/calls";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * GET /api/messenger/calls/incoming — polled every ~5s by the client while
 * the messenger UI is open, to surface ringing calls the user is a callee
 * for (signaling substitute — no persistent WS connection for calls).
 */
export async function GET() {
  if (!isEnabled("messenger")) return frozenResponse("messenger");
  try {
    const userId = await getOptionalSocialUserId();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const rl = await rateLimit("messengerCallsIncoming", userId, { limit: 30, window: 60 });
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

    const calls = await listIncomingCalls(userId);
    return NextResponse.json({ calls });
  } catch (err: unknown) {
    logger.error({ err }, "[messenger] incoming calls poll failed");
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
