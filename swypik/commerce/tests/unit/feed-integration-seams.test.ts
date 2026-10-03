import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { withFollowing, withLike, withSave } from "@/components/explore/patches";
import { findLinkedVideo, parseFeedDeepLink } from "@/components/explore/deep-link";
import { commentDomId, mergeFocusedThread } from "@/components/social/comments/focus";
import type { CommentItemData } from "@/components/social/comments/types";
import type { FeedItem, FeedVideo } from "@/lib/feed/types";
import { videoPath } from "@/lib/social/links";

/** Cusăturile feed ↔ social: rail-ul folosește LikeButton/FollowButton, deep link-urile din notificări. */

const V1 = "11111111-1111-4111-8111-111111111111";
const V2 = "22222222-2222-4222-8222-222222222222";
const C1 = "33333333-3333-4333-8333-333333333333";

function video(id: string, creatorId = "cr-1", over: Partial<FeedVideo> = {}): FeedVideo {
  return {
    id, url: null, hlsUrl: null, fallbackUrl: null, thumbnail: null, duration: null,
    creator: { id: creatorId, username: "ana", name: "Ana", verified: false, avatar: null },
    description: "", likes: 10, saves: 2, shares: 0, comments: 3,
    viewer: { liked: false, saved: false, following: false },
    product: null, audioTrack: null, movie: null, mission: null, captionLangs: [],
    ...over,
  };
}
const item = (v: FeedVideo): FeedItem => ({ kind: "video", key: `video:${v.id}`, video: v });

describe("rail-ul feed-ului → componentele sociale", () => {
  it("ActionRail folosește LikeButton/FollowButton; copiile locale au dispărut", () => {
    const src = readFileSync(resolve(__dirname, "../../components/explore/ActionRail.tsx"), "utf8");
    expect(src).toContain("@/components/social/LikeButton");
    expect(src).toContain("@/components/social/FollowButton");
    expect(src).not.toMatch(/FeedLikeAction|FeedFollowAction/);
  });

  it("starea confirmată de server (like) se scrie în payload", () => {
    const v = video(V1);
    const next = withLike({ liked: true, count: 42 })(v);
    expect(next).toMatchObject({ likes: 42, viewer: { liked: true, saved: false, following: false } });
    expect(v.likes).toBe(10);
    expect(withLike({ liked: false, count: -3 })(v).likes).toBe(0);
    expect(withSave({ saved: true, count: 5 })(v)).toMatchObject({ saves: 5, viewer: { saved: true } });
  });

  it("follow se aplică tuturor clipurilor creatorului, fără să atingă restul", () => {
    const items = [item(video(V1, "cr-1")), item(video(V2, "cr-2")), { kind: "news", key: "news:x", card: {} as never } as FeedItem];
    const next = withFollowing(items, "cr-1", true);
    expect((next[0] as Extract<FeedItem, { kind: "video" }>).video.viewer.following).toBe(true);
    expect(next[1]).toBe(items[1]);
    expect(next[2]).toBe(items[2]);
  });
});

describe("deep link /explore?v=…&comment=… (și / cu ?v=)", () => {
  const params = (qs: string) => new URLSearchParams(qs);

  it("linkul canonic din notificări se parsează înapoi", () => {
    const qs = videoPath(V1, C1).split("?")[1];
    expect(parseFeedDeepLink(params(qs))).toEqual({ videoId: V1, commentId: C1 });
    expect(parseFeedDeepLink(params(`v=${V1}`))).toEqual({ videoId: V1, commentId: null });
  });

  it("id-urile invalide sunt ignorate", () => {
    expect(parseFeedDeepLink(params("v=nope&comment=" + C1))).toBeNull();
    expect(parseFeedDeepLink(params(`v=${V1}&comment=../x`))).toEqual({ videoId: V1, commentId: null });
    expect(parseFeedDeepLink(params(""))).toBeNull();
  });

  it("foaia se deschide doar dacă clipul țintă a ajuns în feed", () => {
    const items = [item(video(V2)), item(video(V1))];
    expect(findLinkedVideo(items, { videoId: V1, commentId: C1 })?.id).toBe(V1);
    expect(findLinkedVideo(items, { videoId: C1, commentId: null })).toBeNull();
    expect(findLinkedVideo(items, null)).toBeNull();
  });

  it("FeedScreen citește linkul și trimite comentariul țintă în CommentsSheet", () => {
    const src = readFileSync(resolve(__dirname, "../../components/explore/FeedScreen.tsx"), "utf8");
    expect(src).toContain("parseFeedDeepLink(searchParams)");
    expect(src).toContain("focusCommentId={focusCommentId}");
  });
});

describe("CommentsSheet: firul țintă primul", () => {
  const c = (id: string, over: Partial<CommentItemData> = {}): CommentItemData => ({
    id, videoId: V1, userId: null, parentCommentId: null, text: id, likeCount: 0, replyCount: 0,
    createdAt: "2026-09-25T00:00:00Z", replies: [], viewerLiked: false, isPinned: false, canDelete: false, canPin: false,
    repliesCursor: null, author: { id: null, username: null, displayName: "x", avatarUrl: null, isVideoOwner: false },
    ...over,
  });

  it("fără țintă: nimic nu se schimbă", () => {
    const list = [c("a"), c("b")];
    expect(mergeFocusedThread(null, list, null)).toEqual({ pinned: null, comments: list });
  });

  it("ținta e pusă prima și nu apare de două ori", () => {
    const focused = c("b", { replies: [c("r1", { parentCommentId: "b" })] });
    const out = mergeFocusedThread(null, [c("a"), c("b")], focused);
    expect(out.comments.map((x) => x.id)).toEqual(["b", "a"]);
    expect(out.comments[0].replies).toHaveLength(1);
  });

  it("ținta = comentariul fixat → îl înlocuiește (aduce răspunsul țintă)", () => {
    const pinned = c("p", { isPinned: true });
    const focused = c("p", { isPinned: true, replies: [c("r9", { parentCommentId: "p" })] });
    const out = mergeFocusedThread(pinned, [c("a")], focused);
    expect(out.pinned?.replies[0].id).toBe("r9");
    expect(out.comments.map((x) => x.id)).toEqual(["a"]);
  });

  it("id-ul DOM e stabil (derularea la țintă)", () => {
    expect(commentDomId(C1)).toBe(`comment-${C1}`);
  });
});
