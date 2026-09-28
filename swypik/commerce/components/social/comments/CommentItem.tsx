"use client";

import type { ReactNode } from "react";
import { MoreHorizontal, Pin } from "lucide-react";
import { useTranslations } from "next-intl";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { IconButton } from "@/components/ui/IconButton";
import { Link } from "@/lib/i18n/navigation";
import { relativeTime } from "@/lib/social/format";
import { profilePath } from "@/lib/social/links";
import { cn } from "@/lib/ui/cn";
import LikeButton from "../LikeButton";
import { CommentText } from "./CommentText";
import { commentDomId } from "./focus";
import type { CommentItemData } from "./types";

export type CommentItemHandlers = {
  onReply: (comment: CommentItemData) => void;
  onMore: (comment: CommentItemData) => void;
  onLoadReplies: (comment: CommentItemData) => void;
  onLiked: (id: string, liked: boolean, count: number) => void;
  /** Comentariul evidențiat (deep link din notificări). */
  focusId?: string | null;
};

function AuthorLink({ comment, children, className }: { comment: CommentItemData; children: ReactNode; className?: string }) {
  const username = comment.author.username;
  if (!username) return <span className={className}>{children}</span>;
  return (
    <Link href={profilePath(username)} className={className}>
      {children}
    </Link>
  );
}

export function CommentItem({ comment, isReply = false, ...h }: { comment: CommentItemData; isReply?: boolean } & CommentItemHandlers) {
  const t = useTranslations("social.comments");
  const rel = relativeTime(comment.createdAt);
  const time = rel.unit === "now" ? t("time.now") : t(`time.${rel.unit}`, { count: rel.value });
  const hiddenReplies = Math.max(0, comment.replyCount - comment.replies.length);

  return (
    <li
      id={commentDomId(comment.id)}
      aria-current={h.focusId === comment.id ? "true" : undefined}
      className={cn(
        "flex gap-3",
        isReply ? "pt-3" : "py-3",
        h.focusId === comment.id && "-mx-2 rounded-card bg-brand-soft px-2 motion-safe:transition-colors motion-safe:duration-slow",
      )}
    >
      <AuthorLink comment={comment} className="shrink-0">
        <Avatar src={comment.author.avatarUrl} name={comment.author.displayName} size={isReply ? "sm" : "md"} />
      </AuthorLink>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <AuthorLink comment={comment} className="truncate text-xs font-semibold text-muted hover:text-fg">
            {comment.author.displayName}
          </AuthorLink>
          {comment.author.isVideoOwner ? <Badge tone="brand">{t("creator")}</Badge> : null}
          {comment.isPinned ? (
            <span className="inline-flex items-center gap-1 text-xs font-semibold text-subtle">
              <Pin aria-hidden className="h-3 w-3" />
              {t("pinned")}
            </span>
          ) : null}
        </div>
        <CommentText text={comment.text} />
        <div className="mt-1 flex items-center gap-3 text-xs text-subtle">
          <time dateTime={comment.createdAt}>{time}</time>
          <button
            type="button"
            onClick={() => h.onReply(comment)}
            className="min-h-11 font-semibold text-muted hover:text-fg"
          >
            {t("reply")}
          </button>
          <IconButton label={t("moreActions")} size="sm" onClick={() => h.onMore(comment)} className="text-subtle">
            <MoreHorizontal aria-hidden />
          </IconButton>
        </div>

        {comment.replies.length > 0 ? (
          <ul className="border-l border-subtle pl-3">
            {comment.replies.map((reply) => (
              <CommentItem key={reply.id} comment={reply} isReply {...h} />
            ))}
          </ul>
        ) : null}
        {!isReply && hiddenReplies > 0 && comment.repliesCursor ? (
          <button
            type="button"
            onClick={() => h.onLoadReplies(comment)}
            className="min-h-11 text-xs font-semibold text-muted hover:text-fg"
          >
            {t("viewReplies", { count: hiddenReplies })}
          </button>
        ) : null}
      </div>
      <LikeButton
        target="comment"
        variant="inline"
        targetId={comment.id}
        initialLiked={comment.viewerLiked}
        initialCount={comment.likeCount}
        onChange={(s) => h.onLiked(comment.id, s.liked, s.count)}
      />
    </li>
  );
}
