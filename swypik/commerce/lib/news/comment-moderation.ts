/**
 * Moderarea comentariilor la știri (UGC):
 *   - la publicare: Azure AI Content Safety (lib/ai/moderate.ts). block → refuzat;
 *     review sau serviciu indisponibil → salvat „moderated” (ascuns) pentru revizuire,
 *     nu publicat direct. Neconfigurat → publicat (rămân raportul + blocarea);
 *   - raport → moderation_reports (țintă = autorul, comentariul în metadata);
 *   - blocare → user_blocks (lib/social/blocks.ts): comentariile celor doi se
 *     ascund reciproc (GET-ul filtrează cu notBlockedSql).
 * Clientul nu primește niciodată user_id-ul autorului.
 */
import { dbQuery } from "@/lib/db";
import { moderate } from "@/lib/ai/moderate";
import { blockUser } from "@/lib/social/blocks";
import { logger } from "@/lib/logger";

export type CommentScreen = { status: "published" | "moderated" } | { status: "rejected" };

export async function screenNewsComment(content: string): Promise<CommentScreen> {
  const verdict = await moderate(content, "news_comment");
  if (verdict.decision === "block") {
    logger.info({ reasons: verdict.reasons }, "news.comment.blocked");
    return { status: "rejected" };
  }
  return { status: verdict.flagged ? "moderated" : "published" };
}

export async function publishedArticleIdForSlug(slug: string): Promise<string | null> {
  const { rows } = await dbQuery<{ id: string }>(
    `SELECT id FROM news_articles WHERE slug = $1 AND status = 'published' LIMIT 1`,
    [slug],
  );
  return rows[0]?.id ?? null;
}

async function commentAuthor(articleId: string, commentId: string): Promise<{ userId: string; content: string } | null> {
  const { rows } = await dbQuery<{ user_id: string; content: string }>(
    `SELECT user_id, content FROM news_comments WHERE id = $1 AND article_id = $2 AND status = 'published'`,
    [commentId, articleId],
  );
  return rows[0] ? { userId: rows[0].user_id, content: rows[0].content } : null;
}

export const NEWS_COMMENT_REPORT_REASONS = ["spam", "harassment", "hate", "violence", "sexual_content", "scam", "other"] as const;
export type NewsCommentReportReason = (typeof NEWS_COMMENT_REPORT_REASONS)[number];

export type CommentActionResult = { ok: true } | { ok: false; code: "not_found" | "own_comment" };

export async function reportNewsComment(
  articleId: string,
  commentId: string,
  reporterId: string,
  reason: NewsCommentReportReason,
): Promise<CommentActionResult> {
  const author = await commentAuthor(articleId, commentId);
  if (!author) return { ok: false, code: "not_found" };
  if (author.userId === reporterId) return { ok: false, code: "own_comment" };
  await dbQuery(
    `INSERT INTO moderation_reports (reporter_user_id, target_user_id, reason, metadata)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT DO NOTHING`,
    [reporterId, author.userId, reason, JSON.stringify({ kind: "news_comment", article_id: articleId, comment_id: commentId, content: author.content.slice(0, 500) })],
  );
  return { ok: true };
}

export async function blockNewsCommentAuthor(articleId: string, commentId: string, viewerId: string): Promise<CommentActionResult> {
  const author = await commentAuthor(articleId, commentId);
  if (!author) return { ok: false, code: "not_found" };
  if (author.userId === viewerId) return { ok: false, code: "own_comment" };
  await blockUser(viewerId, author.userId);
  return { ok: true };
}
