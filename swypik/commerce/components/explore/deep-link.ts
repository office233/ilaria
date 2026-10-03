/**
 * Deep link în feed: `/?v=<video>` sau `/explore?v=<video>&comment=<comentariu>`
 * (linkurile din notificări, lib/social/links.ts). Serverul pune clipul `v` primul
 * (lib/feed/serve.ts); aici decidem dacă foaia de comentarii se deschide pe el.
 */
import type { FeedItem, FeedVideo } from "@/lib/feed/types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type FeedDeepLink = { videoId: string; commentId: string | null };

/** Citește parametrii; id-urile invalide sunt ignorate (fără cereri inutile). */
export function parseFeedDeepLink(params: { get: (key: string) => string | null }): FeedDeepLink | null {
  const videoId = params.get("v");
  if (!videoId || !UUID_RE.test(videoId)) return null;
  const comment = params.get("comment");
  return { videoId, commentId: comment && UUID_RE.test(comment) ? comment : null };
}

/** Clipul țintă, dacă a ajuns în feed (poate lipsi: șters, ascuns, restricționat). */
export function findLinkedVideo(items: readonly FeedItem[], link: FeedDeepLink | null): FeedVideo | null {
  if (!link) return null;
  for (const it of items) if (it.kind === "video" && it.video.id === link.videoId) return it.video;
  return null;
}
