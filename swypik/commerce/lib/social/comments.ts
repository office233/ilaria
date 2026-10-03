export type CommentStatus = "visible" | "hidden" | "deleted" | "flagged";

/** Stable codes only — no human-readable text. Callers translate `code` for
 * the user (see `app/api/videos/[id]/comments/route.ts`, which returns it
 * verbatim as `{ error: code }`, and `components/social/CommentsSheet.tsx`,
 * which maps the code to a localized string). Audit 2026-09-24 (wave2-misc):
 * this used to return hardcoded English sentences shown raw to non-English
 * users. */
export type CommentValidationCode = "comment_text_required" | "comment_text_too_long";

export type CommentValidationResult =
  | { ok: true; text: string }
  | { ok: false; code: CommentValidationCode };

export type CommentAuthor = {
  id: string | null;
  username: string | null;
  displayName: string;
  avatarUrl: string | null;
  /** Autorul e proprietarul clipului (etichetă „Creator" în foaie). */
  isVideoOwner: boolean;
};

export type CommentView = {
  id: string;
  videoId: string;
  userId: string | null;
  parentCommentId: string | null;
  text: string;
  status: CommentStatus;
  likeCount: number;
  replyCount: number;
  createdAt: string;
  author: CommentAuthor;
  replies: CommentView[];
  /** true dacă viewerul curent a apreciat comentariul (seed pentru CommentsSheet). */
  viewerLiked: boolean;
  isPinned: boolean;
  /** Calculate pe server pentru viewerul curent (inclusiv autori anonimi). */
  canDelete: boolean;
  canPin: boolean;
  /** Cursorul după ultimul răspuns livrat inline („vezi mai multe răspunsuri"). */
  repliesCursor: string | null;
};

/** Cine vede comentariul — decide `canDelete` / `canPin`. */
export type CommentViewerContext = {
  viewerId: string | null;
  /** Viewerul are cont real (nu shell anonim) — necesar pentru fixare. */
  viewerIsAccount: boolean;
  videoOwnerId: string | null;
};

export const MAX_COMMENT_LENGTH = 500;
const FLAGGED_TERMS = [
  "scam",
  "fake",
  "frauda",
  "teapa",
  "țeapă",
  "spam",
  "http://",
  "https://",
];

function toNonNegativeNumber(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.trunc(num));
}

function toIsoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (value && typeof (value as { toISOString?: unknown }).toISOString === "function") {
    return (value as { toISOString: () => string }).toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

export function validateCommentText(input: unknown): CommentValidationResult {
  if (typeof input !== "string") {
    return { ok: false, code: "comment_text_required" };
  }

  const text = input.replace(/\s+/g, " ").trim();
  if (!text) {
    return { ok: false, code: "comment_text_required" };
  }

  if (text.length > MAX_COMMENT_LENGTH) {
    return { ok: false, code: "comment_text_too_long" };
  }

  return { ok: true, text };
}

export function chooseCommentStatus(text: string): CommentStatus {
  const normalized = text.toLowerCase();
  return FLAGGED_TERMS.some((term) => normalized.includes(term)) ? "flagged" : "visible";
}

export type CommentRow = {
  id: unknown;
  video_id: unknown;
  user_id?: unknown;
  parent_comment_id?: unknown;
  body?: unknown;
  status?: unknown;
  like_count?: unknown;
  reply_count?: unknown;
  created_at?: unknown;
  pinned_at?: unknown;
  viewer_liked?: unknown;
  username?: unknown;
  display_name?: unknown;
  avatar_url?: unknown;
};

/** Locale-uri suportate pentru fallback-ul numelui de autor. */
export type CommentLocale = "ro" | "en" | "es" | "fr" | "de" | "pt" | "it";

const ANONYMOUS_AUTHOR_FALLBACK: Record<CommentLocale, string> = {
  ro: "Comunitate",
  en: "Community",
  es: "Comunidad",
  fr: "Communauté",
  de: "Community",
  pt: "Comunidade",
  it: "Community",
};

const NO_VIEWER: CommentViewerContext = { viewerId: null, viewerIsAccount: false, videoOwnerId: null };

/** Reguli de permisiuni, pure (testate în tests/unit/social-comments-thread.test.ts). */
export function commentPermissions(
  comment: { userId: string | null; parentCommentId: string | null },
  ctx: CommentViewerContext,
): { canDelete: boolean; canPin: boolean } {
  const viewer = ctx.viewerId;
  const isOwner = Boolean(viewer && ctx.videoOwnerId && viewer === ctx.videoOwnerId);
  return {
    canDelete: Boolean(viewer && (comment.userId === viewer || isOwner)),
    canPin: isOwner && ctx.viewerIsAccount && comment.parentCommentId === null,
  };
}

export function mapCommentRow(
  row: CommentRow,
  locale: CommentLocale = "ro",
  ctx: CommentViewerContext = NO_VIEWER,
): CommentView {
  const displayName = String(row.display_name || row.username || ANONYMOUS_AUTHOR_FALLBACK[locale] || ANONYMOUS_AUTHOR_FALLBACK.ro);
  const userId = row.user_id ? String(row.user_id) : null;
  const parentCommentId = row.parent_comment_id ? String(row.parent_comment_id) : null;

  return {
    id: String(row.id),
    videoId: String(row.video_id),
    userId,
    parentCommentId,
    text: String(row.body || ""),
    status: (row.status || "visible") as CommentStatus,
    likeCount: toNonNegativeNumber(row.like_count),
    replyCount: toNonNegativeNumber(row.reply_count),
    createdAt: toIsoString(row.created_at),
    viewerLiked: Boolean(row.viewer_liked),
    isPinned: Boolean(row.pinned_at),
    ...commentPermissions({ userId, parentCommentId }, ctx),
    repliesCursor: null,
    author: {
      id: userId,
      username: row.username ? String(row.username) : null,
      displayName,
      avatarUrl: row.avatar_url ? String(row.avatar_url) : null,
      isVideoOwner: Boolean(userId && ctx.videoOwnerId && userId === ctx.videoOwnerId),
    },
    replies: [],
  };
}

export function attachReplies(
  topLevelRows: CommentRow[],
  replyRows: CommentRow[],
  locale: CommentLocale = "ro",
  ctx: CommentViewerContext = NO_VIEWER,
): CommentView[] {
  const comments = topLevelRows.map((row) => mapCommentRow(row, locale, ctx));
  const byId = new Map(comments.map((comment) => [comment.id, comment]));

  for (const row of replyRows) {
    const reply = mapCommentRow(row, locale, ctx);
    const parent = reply.parentCommentId ? byId.get(reply.parentCommentId) : null;
    if (parent) parent.replies.push(reply);
  }

  return comments;
}
