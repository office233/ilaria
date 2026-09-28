"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale } from "next-intl";
import { mergeFocusedThread } from "./focus";
import { toErrorCode, type CommentErrorCode, type CommentItemData, type CommentsViewer } from "./types";

type ListResponse = {
  pinned?: CommentItemData | null;
  /** Firul comentariului cerut prin `focus` (doar pe prima pagină). */
  focused?: CommentItemData | null;
  comments?: CommentItemData[];
  nextCursor?: string | null;
  totalCount?: number;
  allowComments?: boolean;
  viewer?: CommentsViewer;
  error?: string;
};

export type MutationResult = { ok: true } | { ok: false; code: CommentErrorCode; status: number };

const NO_VIEWER: CommentsViewer = { id: null, isAccount: false, isVideoOwner: false };

function mapTree(list: CommentItemData[], id: string, fn: (c: CommentItemData) => CommentItemData | null): CommentItemData[] {
  const out: CommentItemData[] = [];
  for (const c of list) {
    if (c.id === id) {
      const next = fn(c);
      if (next) out.push(next);
      continue;
    }
    out.push(c.replies.length ? { ...c, replies: mapTree(c.replies, id, fn) } : c);
  }
  return out;
}

/**
 * Starea foii de comentarii: listă cu cursor, răspunsuri, creare/ștergere/fixare.
 * `focusId` (deep link) aduce firul acelui comentariu primul, pe prima pagină.
 */
export function useComments(
  videoId: string | null,
  open: boolean,
  onCountChange?: (count: number) => void,
  focusId?: string | null,
) {
  const locale = useLocale();
  const [pinned, setPinned] = useState<CommentItemData | null>(null);
  const [comments, setComments] = useState<CommentItemData[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [allowComments, setAllowComments] = useState(true);
  const [viewer, setViewer] = useState<CommentsViewer>(NO_VIEWER);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [loadingMore, setLoadingMore] = useState(false);
  const requestId = useRef(0);

  const setCount = useCallback((count: number) => {
    setTotalCount(count);
    onCountChange?.(count);
  }, [onCountChange]);

  const fetchPage = useCallback(async (cursor: string | null) => {
    const qs = new URLSearchParams({ locale });
    if (cursor) qs.set("cursor", cursor);
    else if (focusId) qs.set("focus", focusId);
    const res = await fetch(`/api/videos/${encodeURIComponent(videoId as string)}/comments?${qs}`, {
      credentials: "include",
      cache: "no-store",
    });
    if (!res.ok) throw new Error(String(res.status));
    return (await res.json()) as ListResponse;
  }, [focusId, locale, videoId]);

  const reload = useCallback(async () => {
    if (!videoId) return;
    const id = ++requestId.current;
    setStatus("loading");
    try {
      const data = await fetchPage(null);
      if (id !== requestId.current) return;
      const merged = mergeFocusedThread(data.pinned ?? null, data.comments ?? [], data.focused);
      setPinned(merged.pinned);
      setComments(merged.comments);
      setNextCursor(data.nextCursor ?? null);
      setAllowComments(data.allowComments !== false);
      setViewer(data.viewer ?? NO_VIEWER);
      setCount(Number(data.totalCount) || 0);
      setStatus("ready");
    } catch {
      if (id === requestId.current) setStatus("error");
    }
  }, [fetchPage, setCount, videoId]);

  useEffect(() => {
    if (open && videoId) void reload();
  }, [open, videoId, reload]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await fetchPage(nextCursor);
      setComments((prev) => {
        const seen = new Set(prev.map((c) => c.id));
        return [...prev, ...(data.comments ?? []).filter((c) => !seen.has(c.id))];
      });
      setNextCursor(data.nextCursor ?? null);
    } catch {
      // butonul „Încarcă mai multe" rămâne — reîncercare la un tap
    } finally {
      setLoadingMore(false);
    }
  }, [fetchPage, loadingMore, nextCursor]);

  const updateAll = useCallback((id: string, fn: (c: CommentItemData) => CommentItemData | null) => {
    setComments((prev) => mapTree(prev, id, fn));
    setPinned((prev) => (prev ? mapTree([prev], id, fn)[0] ?? null : prev));
  }, []);

  const loadReplies = useCallback(async (parent: CommentItemData) => {
    if (!videoId || !parent.repliesCursor) return;
    const qs = new URLSearchParams({ locale, parent_comment_id: parent.id, cursor: parent.repliesCursor });
    const res = await fetch(`/api/videos/${encodeURIComponent(videoId)}/comments?${qs}`, { credentials: "include" });
    if (!res.ok) return;
    const data = (await res.json()) as { comments?: CommentItemData[]; nextCursor?: string | null };
    updateAll(parent.id, (c) => ({
      ...c,
      replies: [...c.replies, ...(data.comments ?? []).filter((r) => !c.replies.some((x) => x.id === r.id))],
      repliesCursor: data.nextCursor ?? null,
    }));
  }, [locale, updateAll, videoId]);

  const submit = useCallback(async (text: string, parent: CommentItemData | null): Promise<MutationResult & { hidden?: boolean }> => {
    if (!videoId) return { ok: false, code: "generic", status: 0 };
    const res = await fetch(`/api/videos/${encodeURIComponent(videoId)}/comments?locale=${locale}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ text, parent_comment_id: parent?.id ?? null }),
    }).catch(() => null);
    if (!res) return { ok: false, code: "generic", status: 0 };
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, code: toErrorCode(data?.error), status: res.status };
    const created = data.comment as CommentItemData;
    if (data.moderation_status !== "visible") return { ok: true, hidden: true };
    if (created.parentCommentId) {
      updateAll(created.parentCommentId, (c) => ({ ...c, replies: [...c.replies, created], replyCount: c.replyCount + 1 }));
    } else {
      setComments((prev) => [created, ...prev]);
    }
    setCount(Number(data.comment_count) || 0);
    return { ok: true };
  }, [locale, setCount, updateAll, videoId]);

  const remove = useCallback(async (comment: CommentItemData): Promise<MutationResult> => {
    const qs = new URLSearchParams({ comment_id: comment.id });
    const res = await fetch(`/api/videos/${encodeURIComponent(comment.videoId)}/comments?${qs}`, {
      method: "DELETE",
      credentials: "include",
    }).catch(() => null);
    if (!res) return { ok: false, code: "generic", status: 0 };
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, code: toErrorCode(data?.error), status: res.status };
    updateAll(comment.id, () => null);
    if (comment.parentCommentId) {
      updateAll(comment.parentCommentId, (c) => ({ ...c, replyCount: Math.max(0, c.replyCount - 1) }));
    }
    setCount(Number(data.comment_count) || 0);
    return { ok: true };
  }, [setCount, updateAll]);

  const togglePin = useCallback(async (comment: CommentItemData): Promise<MutationResult> => {
    const res = await fetch(`/api/comments/${encodeURIComponent(comment.id)}/pin`, {
      method: comment.isPinned ? "DELETE" : "PUT",
      credentials: "include",
    }).catch(() => null);
    if (!res) return { ok: false, code: "generic", status: 0 };
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return { ok: false, code: toErrorCode(data?.error), status: res.status };
    }
    await reload();
    return { ok: true };
  }, [reload]);

  const setLiked = useCallback((id: string, liked: boolean, count: number) => {
    updateAll(id, (c) => ({ ...c, viewerLiked: liked, likeCount: count }));
  }, [updateAll]);

  return {
    pinned, comments, nextCursor, totalCount, allowComments, viewer, status, loadingMore,
    reload, loadMore, loadReplies, submit, remove, togglePin, setLiked,
  };
}
