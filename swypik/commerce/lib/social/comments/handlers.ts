/**
 * Handlerii pentru /api/videos/[id]/comments (GET listă/răspunsuri, POST, DELETE).
 * Ruta doar îi reexportă — logica stă aici ca să rămână testabilă și mică.
 */
import { NextResponse, type NextRequest } from "next/server";
import { logger } from "@/lib/logger";
import { moderateUserText, type AiModerationOutcome } from "@/lib/moderation/ai-text";
import { openModerationCase } from "@/lib/moderation/cases";
import { recordStrike } from "@/lib/moderation/strikes";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";
import { DEFAULT_LOCALE, isLocale } from "@/lib/i18n/config";
import {
  anonSessionErrorResponse,
  getOrCreateSocialUser,
  getSocialIdentity,
  setAnonSessionCookie,
} from "@/lib/social/session";
import { VideoCommentPostSchema, parseBody } from "@/lib/validation/schemas";
import { invalidIdResponse, isUuidParam } from "@/lib/validation/params";
import { dbQuery } from "@/lib/db";
import { chooseCommentStatus, validateCommentText, type CommentLocale } from "../comments";
import { SOCIAL_LIMITS, SOCIAL_PAGE } from "../config";
import { decodeCursor, pageLimit } from "../cursor";
import { CommentError, createComment, deleteComment } from "./mutations";
import { getFocusedThread } from "./focus";
import { notifyForComment } from "./notify";
import { getVideoCommentMeta, listComments, listReplies, type ViewerInput } from "./queries";

type Ctx = { params: Promise<{ id: string }> };

function localeOf(req: NextRequest): CommentLocale {
  const raw = req.nextUrl.searchParams.get("locale");
  return isLocale(raw) ? raw : DEFAULT_LOCALE;
}

async function viewerOf(req: NextRequest): Promise<ViewerInput> {
  const identity = await getSocialIdentity().catch(() => null);
  return { viewerId: identity?.userId ?? null, viewerIsAccount: Boolean(identity && !identity.isAnon), locale: localeOf(req) };
}

function errorResponse(error: unknown, label: string): NextResponse {
  const anonErr = anonSessionErrorResponse(error);
  if (anonErr) return anonErr;
  if (error instanceof CommentError) return NextResponse.json({ error: error.code }, { status: error.status });
  logger.error({ err: error }, `[Comments API] ${label}`);
  return NextResponse.json({ error: `failed_to_${label}` }, { status: 500 });
}

export async function getComments(req: NextRequest, { params }: Ctx) {
  try {
    const { id: videoId } = await params;
    if (!isUuidParam(videoId)) return invalidIdResponse();
    const sp = req.nextUrl.searchParams;
    const cursor = sp.get("cursor");
    if (cursor && !decodeCursor(cursor)) return NextResponse.json({ error: "invalid_cursor" }, { status: 400 });
    const parentId = sp.get("parent_comment_id");
    if (parentId && !isUuidParam(parentId)) return invalidIdResponse();
    // `focus` (linkurile din notificări): doar pe prima pagină; un id invalid e ignorat.
    const focusRaw = sp.get("focus");
    const focusId = !cursor && !parentId && focusRaw && isUuidParam(focusRaw) ? focusRaw : null;

    const meta = await getVideoCommentMeta(videoId);
    if (!meta) return NextResponse.json({ error: "video_not_found" }, { status: 404 });
    const viewer = await viewerOf(req);

    if (parentId) {
      const limit = pageLimit(sp.get("limit"), SOCIAL_PAGE.replies, SOCIAL_PAGE.maxPage);
      const page = await listReplies(parentId, meta, viewer, { cursor, limit });
      return NextResponse.json({ ...page, totalCount: meta.commentCount });
    }
    const limit = pageLimit(sp.get("limit"), SOCIAL_PAGE.comments, SOCIAL_PAGE.maxPage);
    const [page, focused] = await Promise.all([
      listComments(videoId, meta, viewer, { cursor, limit }),
      focusId ? getFocusedThread(videoId, focusId, meta, viewer) : Promise.resolve(null),
    ]);
    return NextResponse.json({
      ...page,
      focused,
      hasMore: Boolean(page.nextCursor),
      allowComments: meta.allowComments,
      viewer: { id: viewer.viewerId, isAccount: viewer.viewerIsAccount, isVideoOwner: Boolean(viewer.viewerId && viewer.viewerId === meta.ownerId) },
    });
  } catch (error) {
    return errorResponse(error, "load_comments");
  }
}

function moderationStrike(userId: string, videoId: string, m: AiModerationOutcome) {
  if (m.degraded) return;
  void recordStrike({
    userId,
    label: m.label === "blocked" ? "blocked" : "adult",
    context: "comment",
    refType: "video",
    refId: videoId,
    reason: m.message,
    reasons: m.reasons,
    signals: m.signals as Record<string, unknown>,
  });
}

export async function postComment(req: NextRequest, { params }: Ctx) {
  try {
    const { id: videoId } = await params;
    if (!isUuidParam(videoId)) return invalidIdResponse();
    const parsed = parseBody(VideoCommentPostSchema, await req.json().catch(() => null));
    if (!parsed.ok) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
    const body = parsed.data;
    const text = validateCommentText(body.text ?? body.body ?? body.comment);
    if (!text.ok) return NextResponse.json({ error: text.code }, { status: 400 });
    const parentId = body.parent_comment_id?.trim() || null;
    if (parentId && !isUuidParam(parentId)) return invalidIdResponse();

    // Limită per IP ÎNAINTE de a crea identitatea anonimă (rotirea cookie-ului).
    const rlIp = await rateLimit("videoComment", `ip:${getClientIP(req)}`, SOCIAL_LIMITS.commentPerIp);
    if (!rlIp.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    const session = await getOrCreateSocialUser();
    const rl = await rateLimit("videoComment", session.userId);
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

    const moderation = await moderateUserText(text.text, "comment");
    if (moderation.action === "reject") {
      moderationStrike(session.userId, videoId, moderation);
      return NextResponse.json({ error: "comment_rejected", reasons: moderation.reasons }, { status: 422 });
    }
    if (moderation.action === "hide") moderationStrike(session.userId, videoId, moderation);
    const status = moderation.action === "hide" ? "hidden" : chooseCommentStatus(text.text);

    const isAccount = !session.isAnon;
    const created = await createComment({
      videoId,
      authorId: session.userId,
      text: text.text,
      parentId,
      status: status === "deleted" ? "hidden" : status,
      locale: localeOf(req),
      ctx: { viewerId: session.userId, viewerIsAccount: isAccount, videoOwnerId: null },
    });
    // Ascuns de AI (sau AI indisponibil) → caz în coada de moderare, ca adminul să-l poată reabilita.
    if (moderation.action === "hide" && moderation.ai) {
      void openModerationCase({
        target: { kind: "comment", id: created.comment.id },
        source: "ai_auto",
        reasons: moderation.reasons,
        severity: moderation.degraded ? "low" : "medium",
      });
    }

    if (status === "visible") {
      if (isAccount) {
        await dbQuery(
          `INSERT INTO feed_events (actor_user_id, video_id, comment_id, event_type, audience, score, source, metadata)
           VALUES ($1, $2, $3, 'comment_created', 'global', 7, 'next-comments', $4::jsonb)`,
          [session.userId, videoId, created.comment.id, JSON.stringify({ parent_comment_id: created.comment.parentCommentId })],
        ).catch((err) => logger.warn({ err }, "[comments] feed_event failed"));
      }
      void notifyForComment({
        actor: { userId: session.userId, isAnon: !isAccount },
        videoId,
        commentId: created.comment.id,
        text: text.text,
        videoOwnerId: created.videoOwnerId,
        parentAuthorId: created.parentAuthorId,
      }).catch((err) => logger.warn({ err }, "[comments] notify failed"));
    }

    const response = NextResponse.json(
      { comment: created.comment, comment_count: created.commentCount, moderation_status: status },
      { status: 201 },
    );
    setAnonSessionCookie(response, session.anonSessionId);
    return response;
  } catch (error) {
    return errorResponse(error, "post_comment");
  }
}

/** DELETE /api/videos/[id]/comments?comment_id=… — autorul sau proprietarul clipului. */
export async function removeComment(req: NextRequest, { params }: Ctx) {
  try {
    const { id: videoId } = await params;
    const commentId = req.nextUrl.searchParams.get("comment_id")?.trim();
    if (!isUuidParam(videoId) || !isUuidParam(commentId)) return invalidIdResponse();
    const identity = await getSocialIdentity();
    if (!identity) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const result = await deleteComment(identity.userId, commentId, videoId);
    return NextResponse.json({ success: true, comment_count: result.commentCount });
  } catch (error) {
    return errorResponse(error, "delete_comment");
  }
}
