/**
 * Actualizări pure ale payload-ului feed-ului după acțiunile din rail — ținem
 * contorul și starea viewerului în FeedVideo sincronizate cu răspunsul serverului
 * (LikeButton/FollowButton din components/social raportează starea confirmată).
 */
import type { FeedItem, FeedVideo } from "@/lib/feed/types";

export function withLike(state: { liked: boolean; count: number }): (v: FeedVideo) => FeedVideo {
  return (v) => ({ ...v, likes: Math.max(0, state.count), viewer: { ...v.viewer, liked: state.liked } });
}

export function withSave(state: { saved: boolean; count: number }): (v: FeedVideo) => FeedVideo {
  return (v) => ({ ...v, saves: Math.max(0, state.count), viewer: { ...v.viewer, saved: state.saved } });
}

/** Starea de follow se aplică tuturor clipurilor aceluiași creator din feed. */
export function withFollowing(items: readonly FeedItem[], creatorId: string, following: boolean): FeedItem[] {
  return items.map((it) =>
    it.kind === "video" && it.video.creator.id === creatorId && it.video.viewer.following !== following
      ? { ...it, video: { ...it.video, viewer: { ...it.video.viewer, following } } }
      : it,
  );
}
