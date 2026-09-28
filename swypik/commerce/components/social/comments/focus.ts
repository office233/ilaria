import type { CommentItemData } from "./types";

/**
 * Pune firul comentariului țintă (deep link din notificări) primul în listă:
 * dacă e chiar comentariul fixat, îl înlocuiește pe acela (poate aduce răspunsul
 * țintă); altfel îl scoate din pagină (evităm dublura) și îl pune în față.
 */
export function mergeFocusedThread(
  pinned: CommentItemData | null,
  comments: CommentItemData[],
  focused: CommentItemData | null | undefined,
): { pinned: CommentItemData | null; comments: CommentItemData[] } {
  if (!focused) return { pinned, comments };
  if (pinned && pinned.id === focused.id) return { pinned: focused, comments };
  return { pinned, comments: [focused, ...comments.filter((c) => c.id !== focused.id)] };
}

/** Selectorul DOM al unui comentariu randat (pentru derularea la țintă). */
export function commentDomId(commentId: string): string {
  return `comment-${commentId}`;
}
