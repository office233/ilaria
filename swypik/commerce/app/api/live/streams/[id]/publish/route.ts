import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthSession } from "@/lib/auth/session";
import { decideLiveAccess } from "@/lib/live/access";
import { isLiveMediaConfigured, LIVE_CONFIG, LIVE_TRACK_NAMES } from "@/lib/live/config";
import { liveMediaErrorResponse, liveUnavailable, SdpSchema } from "@/lib/live/http";
import { hostPublish } from "@/lib/live/media";
import { getLiveMediaState } from "@/lib/live/queries";
import { rateLimit } from "@/lib/security/rate-limit";
import { invalidIdResponse, isUuidParam } from "@/lib/validation/params";
import { parseBody } from "@/lib/validation/schemas";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PublishSchema = z.object({
  offer: SdpSchema("offer"),
  tracks: z
    .array(z.object({ mid: z.string().min(1).max(8), trackName: z.enum(LIVE_TRACK_NAMES) }))
    .min(1)
    .max(LIVE_TRACK_NAMES.length)
    .refine((t) => new Set(t.map((x) => x.trackName)).size === t.length, "duplicate_track"),
});

/**
 * POST /api/live/streams/[id]/publish { offer, tracks:[{mid, trackName}] } — doar gazda (sau admin).
 * Creează sesiunea SFU a gazdei și publică track-urile; întoarce răspunsul SDP.
 * Streamul NU devine live aici: abia primul heartbeat cu media activă îl trece în live.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuidParam(id)) return invalidIdResponse();
  if (!isLiveMediaConfigured()) return liveUnavailable();

  const session = await getAuthSession().catch(() => null);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const rl = await rateLimit("liveHostPublish", session.userId, LIVE_CONFIG.rate.hostPublish);
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  const parsed = parseBody(PublishSchema, await req.json().catch(() => ({})));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const stream = await getLiveMediaState(id);
  if (!stream) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const decision = decideLiveAccess("host", stream, { userId: session.userId, role: session.role ?? null });
  if (!decision.ok) return NextResponse.json({ error: decision.error }, { status: decision.status });

  try {
    const tracks = parsed.data.tracks.map((t) => ({ location: "local" as const, mid: t.mid, trackName: t.trackName }));
    const out = await hostPublish(stream, parsed.data.offer, tracks);
    return NextResponse.json({ ...out, heartbeatMs: LIVE_CONFIG.heartbeatIntervalMs });
  } catch (err) {
    return liveMediaErrorResponse(err, { streamId: id, op: "publish" });
  }
}
