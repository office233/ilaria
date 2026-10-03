/**
 * Handler comun pentru /api/videos/[id]/like și /api/comments/[id]/like.
 *
 *   GET    → { liked, like_count }
 *   PUT    → like (idempotent)
 *   DELETE → unlike (idempotent)
 *   POST   → { liked: boolean } setează starea; fără corp = comutare (clienți vechi)
 *
 * Like-ul merge și anonim (decizie de produs 2026-08-25) — limită per IP ÎNAINTE
 * de a crea identitatea, ca rotirea cookie-ului să nu umfle contorul. Semnalul
 * de ranking și notificarea pleacă DOAR pentru conturi reale.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import { notifySocial } from "@/lib/notifications/social";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";
import { ABUSE_LIMITS } from "@/lib/security/abuse-limits";
import {
  anonSessionErrorResponse,
  getOptionalSocialUserId,
  getOrCreateSocialUser,
  getSocialIdentity,
  setAnonSessionCookie,
} from "@/lib/social/session";
import { invalidIdResponse, isUuidParam } from "@/lib/validation/params";
import { SOCIAL_LIMITS } from "./config";
import { hasLiked, LikeTargetUnavailable, readLikeCount, setLike, toggleLike, type LikeTarget } from "./likes";

type Params = { params: Promise<{ id: string }> };
type Mode = "like" | "unlike" | "body";

const LikeBodySchema = z.object({ liked: z.boolean().optional() }).passthrough();

const RL_KEYS: Record<LikeTarget, { user: string; ip: string }> = {
  video: { user: "videoLike", ip: "video_like_ip" },
  comment: { user: "commentLike", ip: "comment_like_ip" },
};

function ipLimit(target: LikeTarget) {
  return target === "video" ? SOCIAL_LIMITS.videoLikePerIp : ABUSE_LIMITS.commentLikePerIp;
}

function body(liked: boolean, likeCount: number, targetId: string) {
  return { liked, like_count: likeCount, likeCount, id: targetId };
}

async function desiredState(req: Request, mode: Mode): Promise<boolean | null | "invalid"> {
  if (mode === "like") return true;
  if (mode === "unlike") return false;
  const raw = await req.json().catch(() => null);
  if (raw === null) return null;
  const parsed = LikeBodySchema.safeParse(raw);
  if (!parsed.success) return "invalid";
  return parsed.data.liked ?? null;
}

async function afterChange(target: LikeTarget, targetId: string, actor: { userId: string; isAnon: boolean }, liked: boolean) {
  if (actor.isAnon) return;
  if (target === "video") {
    await dbQuery(
      `INSERT INTO feed_events (actor_user_id, video_id, event_type, audience, score, source, metadata)
       VALUES ($1, $2, $3, 'global', $4, 'next-like', '{}'::jsonb)`,
      [actor.userId, targetId, liked ? "like" : "unlike", liked ? 5 : 0],
    ).catch((err) => logger.warn({ err }, "[like] feed_event failed"));
  }
  if (!liked) return;
  const { rows } = await dbQuery<{ owner: string | null; video_id: string | null }>(
    target === "video"
      ? `SELECT creator_id AS owner, id AS video_id FROM videos WHERE id = $1`
      : `SELECT user_id AS owner, video_id FROM comments WHERE id = $1`,
    [targetId],
  );
  const row = rows[0];
  void notifySocial({
    recipientId: row?.owner,
    actor,
    notice: target === "video" ? "videoLike" : "commentLike",
    videoId: row?.video_id ?? null,
    commentId: target === "comment" ? targetId : null,
  });
}

export async function handleLikeMutation(req: Request, { params }: Params, target: LikeTarget, mode: Mode) {
  try {
    const { id } = await params;
    if (!isUuidParam(id)) return invalidIdResponse();
    const want = await desiredState(req, mode);
    if (want === "invalid") return NextResponse.json({ error: "invalid_body" }, { status: 400 });

    const ipRl = await rateLimit(RL_KEYS[target].ip, getClientIP(req), ipLimit(target));
    if (!ipRl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

    // Unlike nu creează identitate nouă: fără identitate nu există nimic de retras.
    if (want === false) {
      const identity = await getSocialIdentity();
      if (!identity) {
        const count = await readLikeCount(target, id);
        if (count === null) return NextResponse.json({ error: "not_found" }, { status: 404 });
        return NextResponse.json(body(false, count, id));
      }
    }

    const session = await getOrCreateSocialUser();
    const rl = await rateLimit(RL_KEYS[target].user, session.userId);
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

    const result = want === null
      ? await toggleLike(session.userId, target, id)
      : await setLike(session.userId, target, id, want);
    if (result.changed) {
      await afterChange(target, id, { userId: session.userId, isAnon: Boolean(session.isAnon) }, result.liked);
    }

    const response = NextResponse.json(body(result.liked, result.likeCount, id));
    setAnonSessionCookie(response, session.anonSessionId);
    return response;
  } catch (error) {
    const anonErr = anonSessionErrorResponse(error);
    if (anonErr) return anonErr;
    if (error instanceof LikeTargetUnavailable) {
      const status = error.code === "blocked" ? 403 : 404;
      return NextResponse.json({ error: error.code }, { status });
    }
    logger.error({ err: error, target }, "[like] mutation failed");
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

export async function handleLikeGet({ params }: Params, target: LikeTarget) {
  try {
    const { id } = await params;
    if (!isUuidParam(id)) return invalidIdResponse();
    const viewerId = await getOptionalSocialUserId().catch(() => null);
    const [liked, count] = await Promise.all([hasLiked(viewerId, target, id), readLikeCount(target, id)]);
    if (count === null) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(body(liked, count, id));
  } catch (error) {
    logger.error({ err: error, target }, "[like] GET failed");
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
