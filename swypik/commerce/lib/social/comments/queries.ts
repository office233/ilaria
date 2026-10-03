/**
 * Citirea firelor de comentarii (1 nivel de răspunsuri), cu paginare prin cursor.
 *
 *  - nivel 1: cele mai noi întâi (created_at DESC, id DESC); comentariul fixat
 *    vine separat, doar pe prima pagină, și e exclus din listă;
 *  - răspunsuri: cronologic (created_at ASC, id ASC); primele N vin inline,
 *    restul prin `listReplies` pornind de la `repliesCursor`;
 *  - `totalCount` = `videos.comment_count` (triggerul numără și răspunsurile) —
 *    aceeași cifră ca în feed, deci foaia și butonul nu mai diferă;
 *  - comentariile autorilor aflați în blocare cu viewerul sunt ascunse.
 */
import { dbQuery } from "@/lib/db";
import { notBlockedSql } from "../blocks";
import {
  attachReplies,
  mapCommentRow,
  type CommentLocale,
  type CommentRow,
  type CommentView,
  type CommentViewerContext,
} from "../comments";
import { SOCIAL_PAGE } from "../config";
import { decodeCursor, encodeCursor, nextCursorFrom } from "../cursor";

export const SELECT = `
  c.id, c.video_id, c.user_id, c.parent_comment_id, c.body, c.status,
  c.like_count, c.reply_count, c.created_at, c.pinned_at,
  u.username, u.display_name, u.avatar_url,
  ($VIEWER::uuid IS NOT NULL AND EXISTS (
    SELECT 1 FROM likes l WHERE l.comment_id = c.id AND l.user_id = $VIEWER::uuid
  )) AS viewer_liked`;

export type Row = CommentRow & { id: string; created_at: string };

export type ViewerInput = { viewerId: string | null; viewerIsAccount: boolean; locale?: CommentLocale };

export type VideoCommentMeta = { ownerId: string | null; commentCount: number; allowComments: boolean };

export async function getVideoCommentMeta(videoId: string): Promise<VideoCommentMeta | null> {
  const { rows } = await dbQuery<{ creator_id: string | null; comment_count: string | number; allow_comments: boolean }>(
    `SELECT creator_id, comment_count, allow_comments FROM videos WHERE id = $1`,
    [videoId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    ownerId: row.creator_id,
    commentCount: Math.max(0, Number(row.comment_count) || 0),
    allowComments: row.allow_comments !== false,
  };
}

export function withViewer(sql: string): string {
  return sql.split("$VIEWER").join("$1");
}

export function blockFilter(viewerId: string | null): string {
  return viewerId ? `AND (c.user_id IS NULL OR ${notBlockedSql("c.user_id", "$1")})` : "";
}

/** Primele N răspunsuri pentru fiecare comentariu de nivel 1 din pagină. */
export async function inlineReplies(parentIds: string[], viewerId: string | null): Promise<Row[]> {
  if (parentIds.length === 0) return [];
  const { rows } = await dbQuery<Row & { reply_rank: number }>(
    withViewer(`SELECT * FROM (
       SELECT ${SELECT},
              ROW_NUMBER() OVER (PARTITION BY c.parent_comment_id ORDER BY c.created_at ASC, c.id ASC) AS reply_rank
         FROM comments c
         LEFT JOIN users u ON u.id = c.user_id
        WHERE c.parent_comment_id = ANY($2::uuid[])
          AND c.status = 'visible'
          ${blockFilter(viewerId)}
     ) ranked
     WHERE reply_rank <= $3
     ORDER BY parent_comment_id, created_at ASC, id ASC`),
    [viewerId, parentIds, SOCIAL_PAGE.inlineReplies],
  );
  return rows;
}

export function setRepliesCursors(comments: CommentView[]): void {
  for (const comment of comments) {
    const last = comment.replies[comment.replies.length - 1];
    comment.repliesCursor = last && comment.replyCount > comment.replies.length
      ? encodeCursor(last.createdAt, last.id)
      : null;
  }
}

export type CommentPage = {
  comments: CommentView[];
  pinned: CommentView | null;
  nextCursor: string | null;
  totalCount: number;
};

export async function listComments(
  videoId: string,
  meta: VideoCommentMeta,
  viewer: ViewerInput,
  opts: { cursor: string | null; limit: number },
): Promise<CommentPage> {
  const ctx: CommentViewerContext = { ...viewer, videoOwnerId: meta.ownerId };
  const cursor = decodeCursor(opts.cursor);
  const params: unknown[] = [viewer.viewerId, videoId, opts.limit + 1];
  let cursorSql = "";
  if (cursor) {
    params.push(cursor.at, cursor.id);
    cursorSql = `AND (c.created_at, c.id) < ($4::timestamptz, $5::uuid)`;
  }

  const [{ rows: topRows }, pinnedRows] = await Promise.all([
    dbQuery<Row>(
      withViewer(`SELECT ${SELECT}
         FROM comments c
         LEFT JOIN users u ON u.id = c.user_id
        WHERE c.video_id = $2
          AND c.parent_comment_id IS NULL
          AND c.status = 'visible'
          AND c.pinned_at IS NULL
          ${blockFilter(viewer.viewerId)}
          ${cursorSql}
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT $3`),
      params,
    ),
    cursor
      ? Promise.resolve([] as Row[])
      : dbQuery<Row>(
          withViewer(`SELECT ${SELECT}
             FROM comments c
             LEFT JOIN users u ON u.id = c.user_id
            WHERE c.video_id = $2 AND c.parent_comment_id IS NULL
              AND c.status = 'visible' AND c.pinned_at IS NOT NULL
              ${blockFilter(viewer.viewerId)}
            LIMIT 1`),
          [viewer.viewerId, videoId],
        ).then((r) => r.rows),
  ]);

  const page = nextCursorFrom(topRows, opts.limit, (r) => r.created_at);
  const all = [...pinnedRows, ...page.items];
  const replies = await inlineReplies(all.map((r) => r.id), viewer.viewerId);
  const threaded = attachReplies(all, replies, viewer.locale, ctx);
  setRepliesCursors(threaded);

  const pinned = pinnedRows.length > 0 ? threaded[0] : null;
  return {
    pinned,
    comments: pinned ? threaded.slice(1) : threaded,
    nextCursor: page.nextCursor,
    totalCount: meta.commentCount,
  };
}

export async function listReplies(
  parentId: string,
  meta: VideoCommentMeta,
  viewer: ViewerInput,
  opts: { cursor: string | null; limit: number },
): Promise<{ comments: CommentView[]; nextCursor: string | null }> {
  const ctx: CommentViewerContext = { ...viewer, videoOwnerId: meta.ownerId };
  const cursor = decodeCursor(opts.cursor);
  const params: unknown[] = [viewer.viewerId, parentId, opts.limit + 1];
  let cursorSql = "";
  if (cursor) {
    params.push(cursor.at, cursor.id);
    cursorSql = `AND (c.created_at, c.id) > ($4::timestamptz, $5::uuid)`;
  }
  const { rows } = await dbQuery<Row>(
    withViewer(`SELECT ${SELECT}
       FROM comments c
       LEFT JOIN users u ON u.id = c.user_id
      WHERE c.parent_comment_id = $2
        AND c.status = 'visible'
        ${blockFilter(viewer.viewerId)}
        ${cursorSql}
      ORDER BY c.created_at ASC, c.id ASC
      LIMIT $3`),
    params,
  );
  const page = nextCursorFrom(rows, opts.limit, (r) => r.created_at);
  return {
    comments: page.items.map((row) => mapCommentRow(row, viewer.locale, ctx)),
    nextCursor: page.nextCursor,
  };
}
