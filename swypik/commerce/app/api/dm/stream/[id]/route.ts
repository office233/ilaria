import { frozenResponse, isEnabled } from "@/lib/feature-flags";
import { getOptionalSocialUserId } from "@/lib/social/session";
import { assertParticipant } from "@/lib/dm/repository";
import { dmChannel } from "@/lib/dm/config";
import { isUuidParam } from "@/lib/validation/params";
import { createSseResponse } from "@/lib/realtime/sse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/dm/stream/[id] — SSE stream of new messages for a conversation.
 *
 * Subscribes (through the per-replica realtime hub) to redis channel
 * `dm:conv:<id>`: a message published by ANY web replica reaches this client.
 * Auth: viewer must be a participant.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isEnabled("dm") && !isEnabled("messenger")) return frozenResponse("dm");
  const userId = await getOptionalSocialUserId();
  if (!userId) {
    return new Response("Unauthorized", { status: 401 });
  }
  const { id: conversationId } = await params;
  if (!isUuidParam(conversationId)) return new Response("Bad Request", { status: 400 });
  const ok = await assertParticipant(conversationId, userId);
  if (!ok) {
    return new Response("Forbidden", { status: 403 });
  }

  // Fără Redis: 503 explicit (altfel reconectări fără sfârșit).
  if (!process.env.REDIS_URL) {
    return new Response("Service Unavailable", { status: 503, headers: { "Retry-After": "30" } });
  }

  const channel = dmChannel(conversationId);
  return createSseResponse({
    logTag: "dm/stream",
    channels: [channel],
    requireRealtime: true,
    signal: request.signal,
    onOpen: (send) => send({ channel }, { event: "ready" }),
  });
}
