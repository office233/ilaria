/**
 * Scrierea comentariilor: creare (1 nivel de răspunsuri), ștergere (autor sau
 * proprietarul clipului; răspunsurile unui comentariu șters dispar și ele),
 * fixare (doar proprietarul clipului, un singur comentariu fixat per video).
 * Contoarele (comment_count, reply_count) le ține triggerul din 20260926_0110.
 */
import { dbQuery, withTransaction } from "@/lib/db";
import { isBlockedEitherWay } from "../blocks";
import { mapCommentRow, type CommentLocale, type CommentView, type CommentViewerContext } from "../comments";

export class CommentError extends Error {
  constructor(
    readonly code:
      | "video_not_found"
      | "comments_disabled"
      | "parent_comment_not_found"
      | "comment_not_found"
      | "forbidden"
      | "blocked"
      | "not_top_level",
    readonly status: number,
  ) {
    super(code);
    this.name = "CommentError";
  }
}

type VideoRow = { creator_id: string | null; allow_comments: boolean };

async function loadInteractableVideo(videoId: string): Promise<VideoRow> {
  const { rows } = await dbQuery<VideoRow>(
    `SELECT creator_id, allow_comments FROM videos
      WHERE id = $1 AND status = 'ready' AND visibility IN ('public', 'unlisted')
        AND is_hidden = false AND effective_label = 'safe'`,
    [videoId],
  );
  if (!rows[0]) throw new CommentError("video_not_found", 404);
  if (rows[0].allow_comments === false) throw new CommentError("comments_disabled", 403);
  return rows[0];
}

/** Părintele efectiv (aplatizat la 1 nivel) și autorul lui. */
async function resolveParent(videoId: string, parentId: string): Promise<{ id: string; authorId: string | null }> {
  const { rows } = await dbQuery<{ id: string; parent_comment_id: string | null; user_id: string | null }>(
    `SELECT c.id, c.parent_comment_id, COALESCE(p.user_id, c.user_id) AS user_id
       FROM comments c
       LEFT JOIN comments p ON p.id = c.parent_comment_id
      WHERE c.id = $1 AND c.video_id = $2 AND c.status = 'visible'`,
    [parentId, videoId],
  );
  const row = rows[0];
  if (!row) throw new CommentError("parent_comment_not_found", 404);
  return { id: row.parent_comment_id || row.id, authorId: row.user_id };
}

export type CreateCommentInput = {
  videoId: string;
  authorId: string;
  text: string;
  parentId: string | null;
  status: "visible" | "hidden" | "flagged";
  ctx: CommentViewerContext;
  locale?: CommentLocale;
};

export type CreatedComment = {
  comment: CommentView;
  videoOwnerId: string | null;
  parentAuthorId: string | null;
  commentCount: number;
};

export async function createComment(input: CreateCommentInput): Promise<CreatedComment> {
  const video = await loadInteractableVideo(input.videoId);
  if (video.creator_id && (await isBlockedEitherWay(input.authorId, video.creator_id))) {
    throw new CommentError("blocked", 403);
  }
  let parentId: string | null = null;
  let parentAuthorId: string | null = null;
  if (input.parentId) {
    const parent = await resolveParent(input.videoId, input.parentId);
    if (parent.authorId && (await isBlockedEitherWay(input.authorId, parent.authorId))) {
      throw new CommentError("blocked", 403);
    }
    parentId = parent.id;
    parentAuthorId = parent.authorId;
  }

  const { rows } = await dbQuery(
    `WITH inserted AS (
       INSERT INTO comments (video_id, user_id, parent_comment_id, body, status, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING *
     )
     SELECT i.id, i.video_id, i.user_id, i.parent_comment_id, i.body, i.status,
            i.like_count, i.reply_count, i.created_at, i.pinned_at,
            u.username, u.display_name, u.avatar_url
       FROM inserted i
       LEFT JOIN users u ON u.id = i.user_id`,
    [
      input.videoId,
      input.authorId,
      parentId,
      input.text,
      input.status,
      JSON.stringify({ moderation: input.status === "flagged" ? "keyword_flagged" : "none", source: "next-comments" }),
    ],
  );
  return {
    comment: mapCommentRow(rows[0], input.locale, { ...input.ctx, videoOwnerId: video.creator_id }),
    videoOwnerId: video.creator_id,
    parentAuthorId,
    // Citit DUPĂ instrucțiune: triggerul AFTER a actualizat deja contorul.
    commentCount: await readCommentCount(input.videoId),
  };
}

async function readCommentCount(videoId: string): Promise<number> {
  const { rows } = await dbQuery<{ comment_count: string | number }>(
    `SELECT comment_count FROM videos WHERE id = $1`,
    [videoId],
  );
  return Math.max(0, Number(rows[0]?.comment_count) || 0);
}

type Target = { id: string; video_id: string; user_id: string | null; parent_comment_id: string | null; owner_id: string | null };

async function loadTarget(commentId: string): Promise<Target> {
  const { rows } = await dbQuery<Target>(
    `SELECT c.id, c.video_id, c.user_id, c.parent_comment_id, v.creator_id AS owner_id
       FROM comments c JOIN videos v ON v.id = c.video_id
      WHERE c.id = $1 AND c.status <> 'deleted'`,
    [commentId],
  );
  if (!rows[0]) throw new CommentError("comment_not_found", 404);
  return rows[0];
}

/** Soft-delete; la un comentariu de nivel 1 se șterg și răspunsurile lui. */
export async function deleteComment(viewerId: string, commentId: string, videoId?: string): Promise<{ commentCount: number; videoId: string }> {
  const target = await loadTarget(commentId);
  if (videoId && target.video_id !== videoId) throw new CommentError("comment_not_found", 404);
  if (target.user_id !== viewerId && target.owner_id !== viewerId) throw new CommentError("forbidden", 403);

  await withTransaction(async (q) => {
    await q(`UPDATE comments SET status = 'deleted', pinned_at = NULL WHERE id = $1`, [commentId]);
    if (!target.parent_comment_id) {
      await q(
        `UPDATE comments SET status = 'deleted' WHERE parent_comment_id = $1 AND status <> 'deleted'`,
        [commentId],
      );
    }
  });
  return { commentCount: await readCommentCount(target.video_id), videoId: target.video_id };
}

/** Fixează/defixează; fixarea unuia îl înlocuiește pe cel fixat anterior. */
export async function setPinned(viewerId: string, commentId: string, pinned: boolean): Promise<void> {
  const target = await loadTarget(commentId);
  if (target.owner_id !== viewerId) throw new CommentError("forbidden", 403);
  if (target.parent_comment_id) throw new CommentError("not_top_level", 400);

  await withTransaction(async (q) => {
    await q(`UPDATE comments SET pinned_at = NULL WHERE video_id = $1 AND pinned_at IS NOT NULL`, [target.video_id]);
    if (pinned) {
      const res = await q(
        `UPDATE comments SET pinned_at = now() WHERE id = $1 AND status = 'visible' RETURNING id`,
        [commentId],
      );
      if (res.rows.length === 0) throw new CommentError("comment_not_found", 404);
    }
  });
}
