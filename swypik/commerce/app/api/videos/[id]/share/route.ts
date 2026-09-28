import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import crypto from "crypto";
import { anonSessionErrorResponse, getOrCreateSocialUser, setAnonSessionCookie } from "@/lib/social/session";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";
import { ABUSE_LIMITS } from "@/lib/security/abuse-limits";
import { VideoShareSchema, parseBody } from "@/lib/validation/schemas";

import { logger } from "@/lib/logger";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: videoId } = await params;
    if (!UUID_RE.test(videoId)) {
      return NextResponse.json({ error: "invalid_video_id" }, { status: 400 });
    }
    // Limită per IP înainte de identitate: rotirea cookie-ului nu mai umflă share_count.
    const ipRl = await rateLimit("share_ip", getClientIP(request), ABUSE_LIMITS.sharePerIp);
    if (!ipRl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    const session = await getOrCreateSocialUser();
    const userId = session.userId;

    const rl = await rateLimit("videoShare", userId);
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

    const rawBody = await request.json().catch(() => ({}));
    const parsed = parseBody(VideoShareSchema, rawBody);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error, issues: parsed.issues }, { status: 400 });
    }
    const { channel, referrer_url: referrerUrl, destination_url: destinationUrl } = parsed.data;

    const shareToken = crypto.randomBytes(6).toString("hex");

    const pool = getDb();
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      await client.query(
        `INSERT INTO shares (user_id, video_id, channel, share_token, destination_url, referrer_url, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [userId, videoId, channel, shareToken, destinationUrl, referrerUrl, JSON.stringify({ source: "next-share" })]
      );

      const countRes = await client.query(
        // ANTI-FRAUD (2026-08-09): contorul = numărul real din tabela shares
        // (sursa adevărului), nu incrementare oarbă — evită double-counting
        // cu cron-ul de resync (audit vuln. #4).
        "UPDATE videos SET share_count = (SELECT COUNT(*) FROM shares WHERE video_id = $1) WHERE id = $1 RETURNING share_count",
        [videoId]
      );
      const shareCount = parseInt(countRes.rows[0]?.share_count || "0", 10);

      await client.query(
        `INSERT INTO feed_events (actor_user_id, video_id, event_type, audience, score, source, metadata)
         VALUES ($1, $2, 'video_shared', 'global', 6, 'next-share', $3::jsonb)`,
        [userId, videoId, JSON.stringify({ channel, share_token: shareToken })]
      );

      await client.query("COMMIT");

      const response = NextResponse.json({
        share_token: shareToken,
        share_url: `/v/${shareToken}`,
        share_count: shareCount,
      });
      setAnonSessionCookie(response, session.anonSessionId);
      return response;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } catch (error: any) {
    const anonErr = anonSessionErrorResponse(error);
    if (anonErr) return anonErr;
    logger.error({ err: error }, "[Share API] POST Error:");
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
