/**
 * Firul unui comentariu anume — pentru linkurile din notificări
 * (`/explore?v=<video>&comment=<id>`): comentariul poate fi oriunde în listă
 * (sau un răspuns), deci îl livrăm separat, împreună cu părintele lui de nivel 1,
 * iar foaia de comentarii îl pune primul și îl evidențiază.
 */
import { dbQuery } from "@/lib/db";
import { attachReplies, mapCommentRow, type CommentView, type CommentViewerContext } from "../comments";
import {
  SELECT,
  blockFilter,
  inlineReplies,
  setRepliesCursors,
  withViewer,
  type Row,
  type VideoCommentMeta,
  type ViewerInput,
} from "./queries";

async function visibleComment(videoId: string, commentId: string, viewerId: string | null): Promise<Row | null> {
  const { rows } = await dbQuery<Row>(
    withViewer(`SELECT ${SELECT}
       FROM comments c
       LEFT JOIN users u ON u.id = c.user_id
      WHERE c.id = $2 AND c.video_id = $3 AND c.status = 'visible'
        ${blockFilter(viewerId)}
      LIMIT 1`),
    [viewerId, commentId, videoId],
  );
  return rows[0] ?? null;
}

/**
 * Firul de nivel 1 care conține `commentId` (comentariul însuși sau părintele lui),
 * cu răspunsurile inline + răspunsul țintă garantat prezent. `null` dacă nu e vizibil.
 */
export async function getFocusedThread(
  videoId: string,
  commentId: string,
  meta: VideoCommentMeta,
  viewer: ViewerInput,
): Promise<CommentView | null> {
  const target = await visibleComment(videoId, commentId, viewer.viewerId);
  if (!target) return null;
  const parentId = target.parent_comment_id ? String(target.parent_comment_id) : null;
  const top = parentId ? await visibleComment(videoId, parentId, viewer.viewerId) : target;
  if (!top) return null;

  const ctx: CommentViewerContext = { ...viewer, videoOwnerId: meta.ownerId };
  const replies = await inlineReplies([top.id], viewer.viewerId);
  const [thread] = attachReplies([top], replies, viewer.locale, ctx);
  // Cursorul se calculează pe răspunsurile consecutive, înainte de a adăuga ținta.
  setRepliesCursors([thread]);
  if (parentId && !thread.replies.some((r) => r.id === target.id)) {
    thread.replies.push(mapCommentRow(target, viewer.locale, ctx));
  }
  return thread;
}
