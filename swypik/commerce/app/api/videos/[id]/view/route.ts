import { NextResponse } from "next/server";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";
import {
  recordDedupedVideoView,
  resolveVideoViewerIdentity,
} from "@/lib/video/view-dedupe";

import { logger } from "@/lib/logger";
import { invalidIdResponse, isUuidParam } from "@/lib/validation/params";
export const dynamic = "force-dynamic";

// Câteva persoane anonime pot împărți un IP (NAT, CGNAT mobil).
const ANON_COUNTED_VIEWS_PER_IP_PER_DAY = 3;

/**
 * POST /api/videos/[id]/view
 *
 * A counted view is deduped persistently by authenticated user or first-party
 * anonymous identity for a rolling 24h window. IP/Redis is only a secondary
 * anti-bombing throttle, not the source of truth for ranking/creator metrics.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: videoId } = await params;
    if (!isUuidParam(videoId)) return invalidIdResponse();

    if (!videoId) {
      return NextResponse.json({ error: "Missing video ID" }, { status: 400 });
    }

    const ip = getClientIP(req);

    // Cheap first line of defence. Persistent identity dedupe below is what
    // decides whether view_count may change.
    const perVideo = await rateLimit(
      "videoViewPerVideo",
      `${ip}:${videoId}`,
      { limit: 20, window: 60 },
    );
    if (!perVideo.success) {
      return NextResponse.json({ views: null, throttled: true });
    }

    // Global per-IP cap (anti view-bombing across many videos)
    const perIp = await rateLimit("videoView", ip);
    if (!perIp.success) {
      return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    }

    const identity = await resolveVideoViewerIdentity();
    // Cookie-ul anonim e ales de client (poate fi omis sau rotit la fiecare
    // cerere), deci singur nu deduplică nimic. Vizualizările anonime numărate
    // au și un plafon per IP+video / 24h; utilizatorii logați nu sunt afectați.
    const allowCount =
      identity.kind === "anon"
        ? async () =>
            (await rateLimit("videoViewAnonCounted", `${ip}:${videoId}`, {
              limit: ANON_COUNTED_VIEWS_PER_IP_PER_DAY,
              window: 86_400,
            })).success
        : undefined;
    const result = await recordDedupedVideoView(videoId, identity, allowCount);
    if (!result.found) {
      return NextResponse.json(
        { error: "Video not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({
      views: result.views,
      counted: result.counted,
    });
  } catch (error: any) {
    logger.error({ err: error }, "[Video View API]");
    return NextResponse.json(
      { error: "Failed to record view" },
      { status: 500 }
    );
  }
}
