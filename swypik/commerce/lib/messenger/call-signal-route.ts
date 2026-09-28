/**
 * Handler comun pentru POST /api/messenger/calls/[id]/{decline,end}:
 * id validat (non-UUID → 400, nu 500 din Postgres), cont real, rate limit,
 * apoi închiderea meeting-ului RealtimeKit (altfel rămâne activ și facturat)
 * și oprirea soneriei la ceilalți participanți.
 */
import { NextResponse } from "next/server";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { getAccountUserId } from "@/lib/social/session";
import { rateLimit } from "@/lib/security/rate-limit";
import { isUuid } from "@/lib/validation/uuid";
import { isRtkConfigured } from "@/lib/realtime/config";
import { deactivateMeeting } from "@/lib/realtime/rtk";
import { logger } from "@/lib/logger";
import { CallAuthError, CallNotFoundError, type CallSessionRow } from "./calls";
import { stopRinging } from "./call-ring";

export async function handleCallSignal(
  callId: string,
  op: "decline" | "end",
  action: (userId: string, callId: string) => Promise<CallSessionRow>,
): Promise<Response> {
  if (!isEnabled("messenger")) return frozenResponse("messenger");
  if (!isUuid(callId)) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  try {
    // Cont real obligatoriu: anonimii nu pot scrie DM / apela (audit messenger P0).
    const userId = await getAccountUserId();
    if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const rl = await rateLimit("messengerCallSignal", userId, { limit: 30, window: 60 });
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

    const call = await action(userId, callId);
    // Apel 1:1 — după refuz/închidere meeting-ul nu mai are rost; best effort.
    if (call.rtk_meeting_id && isRtkConfigured()) {
      await deactivateMeeting(call.rtk_meeting_id).catch((err: unknown) =>
        logger.warn({ err, callId, op }, "[messenger] RealtimeKit meeting deactivate failed"),
      );
    }
    await stopRinging(callId, call.conversation_id, userId);
    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    if (err instanceof CallAuthError || err instanceof CallNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    logger.error({ err, op }, "[messenger] call signal failed");
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
