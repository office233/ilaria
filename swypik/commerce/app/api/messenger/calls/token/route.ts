import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAccountUserId } from "@/lib/social/session";
import { dbQuery } from "@/lib/db";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { rateLimit } from "@/lib/security/rate-limit";
import { parseBody } from "@/lib/validation/schemas";
import { createCall, joinCall, prepareCall, CallAuthError, CallNotFoundError } from "@/lib/messenger/calls";
import { isRtkConfigured, RealtimeUnavailableError } from "@/lib/realtime/config";
import { RealtimeApiError } from "@/lib/realtime/http";
import { addParticipant, createMeeting } from "@/lib/realtime/rtk";
import { logger } from "@/lib/logger";
import { ringCallees } from "@/lib/messenger/call-ring";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TokenBodySchema = z.union([
  // Join an existing call.
  z.object({
    callId: z.string().uuid("callId must be a valid UUID"),
  }),
  // Start a new call.
  z.object({
    conversationId: z.string().uuid("conversationId must be a valid UUID"),
    callType: z.enum(["audio", "video"]).default("video"),
  }),
]);

async function displayName(userId: string): Promise<string> {
  const { rows } = await dbQuery<{ display_name: string | null; username: string | null }>(
    `SELECT display_name, username FROM users WHERE id = $1 LIMIT 1`,
    [userId],
  );
  return rows[0]?.display_name || rows[0]?.username || `User_${userId.slice(0, 6)}`;
}

/**
 * POST /api/messenger/calls/token — Cloudflare RealtimeKit.
 *  - { conversationId, callType }: meeting nou + participant (presetare video/audio),
 *    rândul `ringing` se scrie abia DUPĂ ce token-ul a fost emis (fără rânduri orfane).
 *  - { callId }: intră într-un apel existent (callee răspunde / caller revine).
 * Răspuns: { callId, authToken, callType } — token-ul participantului pentru SDK.
 */
export async function POST(req: NextRequest) {
  if (!isEnabled("messenger")) return frozenResponse("messenger");

  try {
    // Cont real obligatoriu: anonimii nu pot scrie DM / apela (audit messenger P0).
    const userId = await getAccountUserId();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    if (!isRtkConfigured()) return NextResponse.json({ error: "calls_unavailable" }, { status: 503 });

    const rl = await rateLimit("messengerCallToken", userId, { limit: 20, window: 60 });
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

    const parsed = parseBody(TokenBodySchema, await req.json().catch(() => ({})));
    if (!parsed.ok) return NextResponse.json({ error: parsed.error, issues: parsed.issues }, { status: 400 });

    const name = await displayName(userId);

    if ("callId" in parsed.data) {
      const joined = await joinCall(userId, parsed.data.callId);
      const { authToken } = await addParticipant(joined.meetingId, { userId, name, media: joined.callType });
      return NextResponse.json({ ok: true, callId: parsed.data.callId, authToken, callType: joined.callType });
    }

    const { conversationId, callType } = parsed.data;
    const { roomName } = await prepareCall(userId, conversationId);
    const meetingId = await createMeeting(roomName);
    const { authToken } = await addParticipant(meetingId, { userId, name, media: callType });
    const { callId } = await createCall(userId, conversationId, callType, { roomName, meetingId });
    // Sună oriunde: SSE global (call:user:<id>) + Web Push; best effort.
    await ringCallees({ callId, conversationId, callerId: userId, callerName: name, callType });
    return NextResponse.json({ ok: true, callId, authToken, callType });
  } catch (err: unknown) {
    if (err instanceof RealtimeUnavailableError) {
      return NextResponse.json({ error: "calls_unavailable" }, { status: 503 });
    }
    if (err instanceof CallAuthError || err instanceof CallNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof RealtimeApiError) {
      logger.error({ err: err.message, code: err.code, status: err.status }, "[messenger] RealtimeKit call failed");
      return NextResponse.json({ error: "calls_provider_error" }, { status: 502 });
    }
    logger.error({ err }, "[messenger] call token error");
    return NextResponse.json({ error: "Failed to generate call token" }, { status: 500 });
  }
}
