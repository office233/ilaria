import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";

import { logger } from "@/lib/logger";
import { invalidIdResponse, isUuidParam } from "@/lib/validation/params";
export const dynamic = "force-dynamic";

/**
 * POST /api/videos/[id]/view
 *
 * Atomically increments view_count. Rate-limited per IP+video via Redis
 * (1 view / 30s window enforced through a tight sliding-window limiter; the
 * generic `videoView` bucket also caps total views/IP/min for view-bombing).
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

    // REAL VIEWS (2026-08-09): 1 view / 24h per IP+video — ca pe TikTok.
    // Re-vizionările aceleiași persoane în aceeași zi NU umflă contorul.
    const perVideo = await rateLimit("videoViewPerVideo", `${ip}:${videoId}`, { limit: 1, window: 86400 });
    if (!perVideo.success) {
      return NextResponse.json({ views: null, throttled: true });
    }

    // Global per-IP cap (anti view-bombing across many videos)
    const perIp = await rateLimit("videoView", ip);
    if (!perIp.success) {
      return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    }

    const { rows } = await dbQuery(
      `UPDATE videos
         SET view_count = view_count + 1
       WHERE id = $1
         AND status = 'ready'
       RETURNING view_count`,
      [videoId]
    );

    if (rows.length === 0) {
      return NextResponse.json(
        { error: "Video not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({ views: Number(rows[0].view_count) });
  } catch (error: any) {
    logger.error({ err: error }, "[Video View API]");
    return NextResponse.json(
      { error: "Failed to record view" },
      { status: 500 }
    );
  }
}
