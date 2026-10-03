"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MessageCircle } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Sheet } from "@/components/ui/Sheet";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { formatCount } from "@/lib/social/format";
import { CommentActions } from "./comments/CommentActions";
import { CommentComposer } from "./comments/CommentComposer";
import { CommentItem } from "./comments/CommentItem";
import { commentDomId } from "./comments/focus";
import type { CommentErrorCode, CommentItemData } from "./comments/types";
import { useComments } from "./comments/useComments";
import { useAuthRedirect } from "./useAuthRedirect";

export type CommentsSheetProps = {
  open: boolean;
  videoId: string | null;
  /** Contorul afișat de feed până la primul răspuns al API-ului. */
  initialCount?: string | number | null;
  onClose: () => void;
  /** Contorul real (include răspunsurile) după încărcare/creare/ștergere. */
  onCountChange?: (nextCount: number) => void;
  /** Deep link (`?comment=`): firul acestui comentariu vine primul, derulat și evidențiat. */
  focusCommentId?: string | null;
};

function parseCount(value: CommentsSheetProps["initialCount"]): number {
  const count = Number(value);
  return Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
}

const ERROR_KEYS: Record<CommentErrorCode, string> = {
  rate_limited: "rateLimitedError",
  comment_text_required: "emptyError",
  comment_text_too_long: "tooLongError",
  comment_rejected: "rejectedError",
  comments_disabled: "disabledError",
  blocked: "blockedError",
  unauthorized: "unauthorizedError",
  forbidden: "unauthorizedError",
  video_not_found: "notFoundError",
  parent_comment_not_found: "notFoundError",
  comment_not_found: "notFoundError",
  generic: "submitError",
};
/** Chei noi (namespace social.comments); restul sunt în commentsSheet. */
const NEW_KEYS = new Set(["rejectedError", "disabledError", "blockedError"]);

/**
 * Foaia de comentarii reutilizabilă (Sheet primitive): fire cu 1 nivel de
 * răspunsuri, like, ștergere/raportare/fixare, @mențiuni, paginare prin cursor.
 */
export default function CommentsSheet({ open, videoId, initialCount, onClose, onCountChange, focusCommentId }: CommentsSheetProps) {
  const t = useTranslations("commentsSheet");
  const ts = useTranslations("social.comments");
  const locale = useLocale();
  const { toast } = useToast();
  const toAuth = useAuthRedirect();
  const c = useComments(videoId, open, onCountChange, focusCommentId);
  const [replyTo, setReplyTo] = useState<CommentItemData | null>(null);
  const [actionsFor, setActionsFor] = useState<CommentItemData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const message = useCallback(
    (code: CommentErrorCode) => {
      const key = ERROR_KEYS[code];
      return NEW_KEYS.has(key) ? ts(key) : t(key);
    },
    [t, ts],
  );

  useEffect(() => {
    if (!open) {
      setReplyTo(null);
      setError(null);
    }
  }, [open]);

  // Deep link: după prima încărcare derulăm o singură dată la comentariul țintă.
  const scrolledTo = useRef<string | null>(null);
  useEffect(() => {
    if (!open) scrolledTo.current = null;
    if (!open || !focusCommentId || c.status !== "ready" || scrolledTo.current === focusCommentId) return;
    scrolledTo.current = focusCommentId;
    const frame = requestAnimationFrame(() => {
      document.getElementById(commentDomId(focusCommentId))?.scrollIntoView({ block: "center" });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, focusCommentId, c.status]);

  // Paginare la derulare: sentinela de la finalul listei cere pagina următoare.
  const { loadMore, nextCursor } = c;
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !nextCursor) return;
    const io = new IntersectionObserver((entries) => entries[0]?.isIntersecting && void loadMore(), { rootMargin: "200px" });
    io.observe(node);
    return () => io.disconnect();
  }, [loadMore, nextCursor]);

  const startReply = useCallback((comment: CommentItemData) => {
    setReplyTo(comment);
    inputRef.current?.focus();
  }, []);

  async function handleSubmit(text: string): Promise<boolean> {
    setError(null);
    const result = await c.submit(text, replyTo);
    if (result.ok) {
      setReplyTo(null);
      if ("hidden" in result && result.hidden) toast({ title: t("sentToModeration"), tone: "info" });
      return true;
    }
    if (result.status === 401) toAuth();
    setError(message(result.code));
    return false;
  }

  const count = c.totalCount ?? parseCount(initialCount);
  const handlers = {
    onReply: startReply,
    onMore: setActionsFor,
    onLoadReplies: (comment: CommentItemData) => void c.loadReplies(comment),
    onLiked: c.setLiked,
    focusId: focusCommentId ?? null,
  };

  return (
    <>
      <Sheet
        open={open}
        onOpenChange={(o) => !o && onClose()}
        title={`${t("title")} · ${formatCount(count, locale)}`}
        className="max-h-[85dvh]"
        footer={
          c.allowComments ? (
            <CommentComposer
              ref={inputRef}
              replyTo={replyTo}
              onCancelReply={() => setReplyTo(null)}
              onSubmit={handleSubmit}
              error={error}
            />
          ) : (
            <p className="text-center text-sm text-muted">{ts("disabledError")}</p>
          )
        }
      >
        {c.status === "loading" || c.status === "idle" ? (
          <div className="flex flex-col gap-4 py-3" aria-busy="true" aria-label={t("loading")}>
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex gap-3">
                <Skeleton className="h-10 w-10 rounded-full" />
                <div className="flex flex-1 flex-col gap-2">
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="h-3 w-full" />
                </div>
              </div>
            ))}
          </div>
        ) : c.status === "error" ? (
          <ErrorState description={t("loadError")} onRetry={() => void c.reload()} />
        ) : !c.pinned && c.comments.length === 0 ? (
          <EmptyState icon={MessageCircle} title={t("emptyTitle")} description={t("emptySubtitle")} />
        ) : (
          <>
            <ul className="divide-y divide-subtle">
              {c.pinned ? <CommentItem comment={c.pinned} {...handlers} /> : null}
              {c.comments.map((comment) => (
                <CommentItem key={comment.id} comment={comment} {...handlers} />
              ))}
            </ul>
            {c.nextCursor ? (
              <div ref={sentinelRef} className="flex justify-center py-3">
                <Button variant="ghost" size="sm" loading={c.loadingMore} onClick={() => void c.loadMore()}>
                  {ts("loadMore")}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </Sheet>

      <CommentActions
        comment={actionsFor}
        viewer={c.viewer}
        onClose={() => setActionsFor(null)}
        onReply={startReply}
        onTogglePin={async (comment) => {
          const r = await c.togglePin(comment);
          if (!r.ok) toast({ title: message(r.code), tone: "danger" });
          return r.ok;
        }}
        onDelete={async (comment) => {
          const r = await c.remove(comment);
          if (!r.ok) toast({ title: t("deleteError"), tone: "danger" });
          return r.ok;
        }}
      />
    </>
  );
}

export { CommentsSheet };
