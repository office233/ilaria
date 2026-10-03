import { NextResponse } from "next/server";
import { z } from "zod";
import { decideLiveAccess } from "@/lib/live/access";
import { isLiveMediaConfigured, LIVE_CONFIG } from "@/lib/live/config";
import { liveMediaErrorResponse, liveUnavailable, SdpSchema, SfuSessionIdSchema } from "@/lib/live/http";
import { viewerAnswer, viewerWatch } from "@/lib/live/media";
import { countViewers } from "@/lib/live/presence";
import { getAuthSession } from "@/lib/auth/session";
import { getLiveMediaState } from "@/lib/live/queries";
import { getClientIP, rateLimit } from "@/lib/security/rate-limit";
import { invalidIdResponse, isUuidParam } from "@/lib/validation/params";
import { parseBody } from "@/lib/validation/schemas";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/live/streams/[id]/watch — spectator (și vizitatori): doar cât streamul
 * e confirmat live. Creează o sesiune SFU proprie care trage track-urile gazdei și
 * întoarce oferta SFU (+ maparea mid → track). Spectatorii nu pot publica nimic.
 * Fiecare apel = o sesiune SFU plătită: vizitatorii fără cont au un plafon strict
 * per IP (LIVE_VIEWER_WATCH_ANON_IP_*), conturile unul per utilizator, iar streamul
 * are un plafon de spectatori (LIVE_MAX_VIEWERS_PER_STREAM).
 */
export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!isUuidParam(id)) return invalidIdResponse();
  if (!isLiveMediaConfigured()) return liveUnavailable();

  const ip = getClientIP(req);
  const rl = await rateLimit("liveViewerWatch", ip, LIVE_CONFIG.rate.viewerWatchIp);
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  const session = await getAuthSession().catch(() => null);
  const perViewer = session
    ? await rateLimit("liveViewerWatchUser", session.userId, LIVE_CONFIG.rate.viewerWatchUser)
    : await rateLimit("liveViewerWatchAnon", ip, LIVE_CONFIG.rate.viewerWatchAnonIp);
  if (!perViewer.success) {
    return NextResponse.json({ error: session ? "rate_limited" : "sign_in_required" }, { status: session ? 429 : 401 });
  }

  const stream = await getLiveMediaState(id);
  if (!stream) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const decision = decideLiveAccess("viewer", stream, null);
  if (!decision.ok) return NextResponse.json({ error: decision.error }, { status: decision.status });

  try {
    if ((await countViewers(id)) >= LIVE_CONFIG.maxViewersPerStream) {
      return NextResponse.json({ error: "stream_full" }, { status: 503 });
    }
    const out = await viewerWatch(stream);
    return NextResponse.json({ ...out, heartbeatMs: LIVE_CONFIG.heartbeatIntervalMs });
  } catch (err) {
    return liveMediaErrorResponse(err, { streamId: id, op: "watch" });
  }
}

const AnswerSchema = z.object({ sessionId: SfuSessionIdSchema, answer: SdpSchema("answer") });

/** PUT /api/live/streams/[id]/watch { sessionId, answer } — răspunsul SDP al spectatorului. */
export async function PUT(req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!isUuidParam(id)) return invalidIdResponse();
  if (!isLiveMediaConfigured()) return liveUnavailable();

  const rl = await rateLimit("liveViewerWatch", getClientIP(req), LIVE_CONFIG.rate.viewerWatchIp);
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  const parsed = parseBody(AnswerSchema, await req.json().catch(() => ({})));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    await viewerAnswer(id, parsed.data.sessionId, parsed.data.answer);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return liveMediaErrorResponse(err, { streamId: id, op: "answer" });
  }
}
