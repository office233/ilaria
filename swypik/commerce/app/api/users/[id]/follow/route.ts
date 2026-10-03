/**
 * Follow pe un utilizator.
 *   GET    → { following, follower_count }
 *   PUT    → follow (idempotent)      DELETE → unfollow (idempotent)
 *   POST   → { following: boolean } setează starea; fără corp = comutare (clienți vechi)
 *
 * Follow-ul merge și anonim (decizie de produs), dar semnalul de ranking și
 * notificarea pleacă doar pentru conturi reale. Blocările (în orice sens) → 403.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import { notifySocial } from "@/lib/notifications/social";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";
import { ABUSE_LIMITS } from "@/lib/security/abuse-limits";
import { FollowError, followerCount, isFollowing, setFollow } from "@/lib/social/follows";
import {
  anonSessionErrorResponse,
  getOptionalSocialUserId,
  getOrCreateSocialUser,
  getSocialIdentity,
  setAnonSessionCookie,
} from "@/lib/social/session";
import { invalidIdResponse, isUuidParam } from "@/lib/validation/params";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };
type Mode = "follow" | "unfollow" | "body";

const FollowBodySchema = z.object({ following: z.boolean().optional() }).passthrough();

const ERROR_STATUS: Record<FollowError["code"], number> = {
  cannot_follow_self: 400,
  user_not_found: 404,
  blocked: 403,
};

async function desired(req: Request, mode: Mode): Promise<boolean | null | "invalid"> {
  if (mode !== "body") return mode === "follow";
  const raw = await req.json().catch(() => null);
  if (raw === null) return null;
  const parsed = FollowBodySchema.safeParse(raw);
  return parsed.success ? parsed.data.following ?? null : "invalid";
}

async function mutate(req: Request, { params }: Ctx, mode: Mode) {
  try {
    const { id: targetId } = await params;
    if (!isUuidParam(targetId)) return invalidIdResponse();
    const want = await desired(req, mode);
    if (want === "invalid") return NextResponse.json({ error: "invalid_body" }, { status: 400 });

    const ipRl = await rateLimit("follow_ip", getClientIP(req), ABUSE_LIMITS.followPerIp);
    if (!ipRl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

    if (want === false && !(await getSocialIdentity())) {
      return NextResponse.json({ following: false, follower_count: await followerCount(targetId) });
    }
    const session = await getOrCreateSocialUser();
    const rl = await rateLimit("userFollow", session.userId);
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

    const next = want ?? !(await isFollowing(session.userId, targetId));
    const result = await setFollow(session.userId, targetId, next);

    if (result.changed && result.following && !session.isAnon) {
      await dbQuery(
        `INSERT INTO feed_events (actor_user_id, event_type, audience, score, source, metadata)
         VALUES ($1, 'creator_followed', 'global', 3, 'next-follow', $2::jsonb)`,
        [session.userId, JSON.stringify({ following_user_id: targetId })],
      ).catch((err) => logger.warn({ err }, "[follow] feed_event failed"));
      void notifySocial({
        recipientId: targetId,
        actor: { userId: session.userId, isAnon: Boolean(session.isAnon) },
        notice: "follow",
      });
    }

    const response = NextResponse.json({ following: result.following, follower_count: result.followerCount });
    setAnonSessionCookie(response, session.anonSessionId);
    return response;
  } catch (error) {
    const anonErr = anonSessionErrorResponse(error);
    if (anonErr) return anonErr;
    if (error instanceof FollowError) {
      return NextResponse.json({ error: error.code }, { status: ERROR_STATUS[error.code] });
    }
    logger.error({ err: error }, "[Follow API] mutation failed");
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

export const POST = (req: Request, ctx: Ctx) => mutate(req, ctx, "body");
export const PUT = (req: Request, ctx: Ctx) => mutate(req, ctx, "follow");
export const DELETE = (req: Request, ctx: Ctx) => mutate(req, ctx, "unfollow");

export async function GET(_req: Request, { params }: Ctx) {
  try {
    const { id: targetId } = await params;
    if (!isUuidParam(targetId)) return invalidIdResponse();
    const viewerId = await getOptionalSocialUserId().catch(() => null);
    const [following, count] = await Promise.all([isFollowing(viewerId, targetId), followerCount(targetId)]);
    return NextResponse.json({ following, follower_count: count });
  } catch (error) {
    logger.error({ err: error }, "[Follow API] GET failed");
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
