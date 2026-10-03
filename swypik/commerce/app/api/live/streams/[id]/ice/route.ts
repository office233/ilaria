import { NextResponse } from "next/server";
import { isLiveMediaConfigured, LIVE_CONFIG } from "@/lib/live/config";
import { liveUnavailable } from "@/lib/live/http";
import { getLiveStream } from "@/lib/live/queries";
import { getIceServers } from "@/lib/realtime/turn";
import { getClientIP, rateLimit } from "@/lib/security/rate-limit";
import { invalidIdResponse, isUuidParam } from "@/lib/validation/params";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/live/streams/[id]/ice — serverele ICE pentru RTCPeerConnection:
 * STUN Cloudflare + (dacă e configurat) credențiale TURN de scurtă durată.
 * Cheia TURN rămâne pe server.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuidParam(id)) return invalidIdResponse();
  if (!isLiveMediaConfigured()) return liveUnavailable();

  const rl = await rateLimit("liveIce", getClientIP(req), LIVE_CONFIG.rate.iceIp);
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  const stream = await getLiveStream(id);
  if (!stream) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (stream.status === "ended" || stream.status === "failed") {
    return NextResponse.json({ error: "stream_ended" }, { status: 409 });
  }
  return NextResponse.json(
    { iceServers: await getIceServers() },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
