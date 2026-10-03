import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthSession } from "@/lib/auth/session";
import { decideLiveAccess } from "@/lib/live/access";
import { isLiveMediaConfigured, LIVE_CONFIG } from "@/lib/live/config";
import { liveMediaErrorResponse, liveUnavailable, SfuSessionIdSchema } from "@/lib/live/http";
import { hostHeartbeat, viewerHeartbeat } from "@/lib/live/media";
import { getLiveMediaState } from "@/lib/live/queries";
import { getClientIP, rateLimit } from "@/lib/security/rate-limit";
import { invalidIdResponse, isUuidParam } from "@/lib/validation/params";
import { parseBody } from "@/lib/validation/schemas";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HeartbeatSchema = z.object({ role: z.enum(["host", "viewer"]), sessionId: SfuSessionIdSchema });

/**
 * POST /api/live/streams/[id]/heartbeat { role, sessionId }
 *  - host (doar creatorul/admin): ține streamul în viață (TTL în Redis); primul
 *    heartbeat cu media activă în SFU trece streamul din scheduled în live.
 *  - viewer: numărat ca spectator; sesiunea trebuie să fie a acestui stream.
 * Răspuns: { status, viewers, publishedAt }.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuidParam(id)) return invalidIdResponse();
  if (!isLiveMediaConfigured()) return liveUnavailable();

  const rl = await rateLimit("liveHeartbeat", getClientIP(req), LIVE_CONFIG.rate.heartbeatIp);
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  const parsed = parseBody(HeartbeatSchema, await req.json().catch(() => ({})));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { role, sessionId } = parsed.data;

  const stream = await getLiveMediaState(id);
  if (!stream) return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    if (role === "host") {
      const session = await getAuthSession().catch(() => null);
      const viewer = session ? { userId: session.userId, role: session.role ?? null } : null;
      const decision = decideLiveAccess("host", stream, viewer);
      if (!decision.ok) return NextResponse.json({ error: decision.error }, { status: decision.status });
      return NextResponse.json(await hostHeartbeat(stream, sessionId));
    }
    return NextResponse.json(await viewerHeartbeat(stream, sessionId));
  } catch (err) {
    return liveMediaErrorResponse(err, { streamId: id, op: "heartbeat", role });
  }
}
