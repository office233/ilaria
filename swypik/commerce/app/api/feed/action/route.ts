import { NextRequest, NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { anonSessionErrorResponse, getOrCreateSocialUser, setAnonSessionCookie } from "@/lib/social/session";
import { applyFeedAction, recordFeedEvent, recordWatchEvent } from "@/lib/db/feed-prefs";
import { rateLimit } from "@/lib/security/rate-limit";
import { FeedActionSchema, parseBody } from "@/lib/validation/schemas";
import { isVideoInteractable } from "@/lib/video/interactable";
import { isBlockedEitherWay } from "@/lib/social/blocks";

import { logger } from "@/lib/logger";
export const dynamic = "force-dynamic";

type FeedAction =
  | "more_like_this"
  | "not_interested"
  | "follow_creator"
  | "unfollow";

const ALLOWED: ReadonlySet<FeedAction> = new Set([
  "more_like_this",
  "not_interested",
  "follow_creator",
  "unfollow",
]);

/**
 * POST /api/feed/action
 * Body: { video_id: string, action: 'more_like_this' | 'not_interested' | 'follow_creator' | 'unfollow' }
 * Response: 204 No Content on success
 *
 * For more_like_this / not_interested:
 *   - inserts into feed_events (REQUIRED for ranking)
 *   - inserts into user_watch_events (granular signal)
 *   - upserts user_interests (+5 / -3 on the video's primary topic)
 *   - not_interested also adds the video to user_hidden_videos
 *
 * For follow_creator / unfollow:
 *   - inserts into feed_events (creator_followed / creator_unfollowed)
 *   - resolves creator_id from videos table
 */
export async function POST(req: NextRequest) {
  try {
    const session = await getOrCreateSocialUser();
    const userId = session.userId;

    const rl = await rateLimit("feedAction", userId);
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

    const rawBody = await req.json().catch(() => null);
    const parsedBody = parseBody(FeedActionSchema, rawBody);
    if (!parsedBody.ok) {
      return NextResponse.json({ error: parsedBody.error }, { status: 400 });
    }
    const { video_id: videoId, action } = parsedBody.data;
    void ALLOWED;

    if (action === "more_like_this" || action === "not_interested") {
      await applyFeedAction({ userId, videoId, action });
    } else {
      // follow_creator / unfollow — resolve creator
      const { rows } = await dbQuery<{ creator_id: string | null }>(
        `SELECT creator_id FROM videos WHERE id = $1`,
        [videoId],
      );
      const creatorId = rows[0]?.creator_id ?? null;

      if (action === "follow_creator") {
        // Doar conturi reale, pe un clip vizibil, fără auto-follow și fără blocări.
        if (session.isAnon) return NextResponse.json({ error: "login_required" }, { status: 401 });
        if (!creatorId || !(await isVideoInteractable(videoId))) {
          return NextResponse.json({ error: "not_found" }, { status: 404 });
        }
        if (creatorId === userId) return NextResponse.json({ error: "cannot_follow_self" }, { status: 400 });
        if (await isBlockedEitherWay(userId, creatorId)) {
          return NextResponse.json({ error: "blocked" }, { status: 403 });
        }
      }

      if (action === "follow_creator" && creatorId) {
        await dbQuery(
          `INSERT INTO follows (follower_user_id, following_user_id)
           VALUES ($1, $2)
           ON CONFLICT (follower_user_id, following_user_id) DO NOTHING`,
          [userId, creatorId],
        );
        await recordFeedEvent({
          userId,
          videoId,
          eventType: "creator_followed",
          metadata: { creator_id: creatorId },
          score: 3,
        });
        await recordWatchEvent({ userId, videoId, eventType: "follow" });
      } else if (action === "unfollow" && creatorId) {
        await dbQuery(
          `DELETE FROM follows WHERE follower_user_id = $1 AND following_user_id = $2`,
          [userId, creatorId],
        );
        await recordFeedEvent({
          userId,
          videoId,
          eventType: "creator_unfollowed",
          metadata: { creator_id: creatorId },
          score: -1,
        });
        await recordWatchEvent({ userId, videoId, eventType: "unfollow" });
      }
    }

    // 204 No Content — set anon cookie if newly minted
    const response = new NextResponse(null, { status: 204 });
    setAnonSessionCookie(response, session.anonSessionId);
    return response;
  } catch (err) {
    const anonErr = anonSessionErrorResponse(err);
    if (anonErr) return anonErr;
    logger.error({ err: err }, "[Feed Action] error:");
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
