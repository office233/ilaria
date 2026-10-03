/** Forma comentariilor pe client — oglinda lui `CommentView` din lib/social/comments.ts. */
export type CommentAuthor = {
  id: string | null;
  username: string | null;
  displayName: string;
  avatarUrl: string | null;
  isVideoOwner: boolean;
};

export type CommentItemData = {
  id: string;
  videoId: string;
  userId: string | null;
  parentCommentId: string | null;
  text: string;
  likeCount: number;
  replyCount: number;
  createdAt: string;
  author: CommentAuthor;
  replies: CommentItemData[];
  viewerLiked: boolean;
  isPinned: boolean;
  canDelete: boolean;
  canPin: boolean;
  repliesCursor: string | null;
};

export type CommentsViewer = { id: string | null; isAccount: boolean; isVideoOwner: boolean };

/** Codurile de eroare ale API-ului care au mesaj dedicat (restul → mesaj generic). */
export const KNOWN_COMMENT_ERRORS = [
  "rate_limited",
  "comment_text_required",
  "comment_text_too_long",
  "comment_rejected",
  "comments_disabled",
  "blocked",
  "unauthorized",
  "forbidden",
  "video_not_found",
  "parent_comment_not_found",
  "comment_not_found",
] as const;
export type CommentErrorCode = (typeof KNOWN_COMMENT_ERRORS)[number] | "generic";

export function toErrorCode(value: unknown): CommentErrorCode {
  return (KNOWN_COMMENT_ERRORS as readonly string[]).includes(String(value)) ? (value as CommentErrorCode) : "generic";
}
