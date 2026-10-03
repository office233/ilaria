/**
 * Servirea feed-ului unificat (GET /api/explore/feed) — orchestrare:
 *   For You   → ranked-page (candidați → scor → bandit → diversitate → snapshot)
 *               → hidratare → seen-set → carduri de modul pe sloturi → cursor;
 *   Following / categorie / profil → keyset cronologic, fără carduri.
 * Toate dependențele sunt injectabile (teste fără DB/Redis).
 */
import crypto from "crypto";
import { generateCandidates } from "./candidates";
import { loadCardPools } from "./cards/providers";
import { loadRankConfig, type AbVariant, type RankConfig } from "./config";
import { decodeCursor, encodeCursor, type FeedCursor } from "./cursor";
import { loadFollowedCreators, loadVideoStats } from "./features";
import { hydrateVideos } from "./hydrate";
import { cardDemand, interleave } from "./interleave";
import { keysetPage, type KeysetFilter } from "./keyset";
import { rankedPage, type RankedPageDeps } from "./ranked-page";
import type { FeedRequest } from "./request";
import { loadSlotRules, type SlotRule } from "./slots";
import { redisFeedStore } from "./store";
import type { FeedResponse, FeedVideo, FeedVideoItem } from "./types";

export type FeedViewer = { userId: string | null; sessionId: string | null; locale: string };

export type ServeDeps = RankedPageDeps & {
  config: (identity: string | null) => Promise<{ config: RankConfig; ab: AbVariant }>;
  slots: () => Promise<SlotRule[]>;
  hydrate: typeof hydrateVideos;
  keyset: typeof keysetPage;
  cards: typeof loadCardPools;
  requestId: () => string;
};

export const defaultServeDeps: ServeDeps = {
  store: redisFeedStore,
  generate: generateCandidates,
  stats: loadVideoStats,
  followed: loadFollowedCreators,
  now: () => new Date(),
  randomSeed: () => crypto.randomBytes(4).readUInt32BE(0),
  config: loadRankConfig,
  slots: loadSlotRules,
  hydrate: hydrateVideos,
  keyset: keysetPage,
  cards: loadCardPools,
  requestId: () => crypto.randomUUID(),
};

export function viewerIdentity(v: Pick<FeedViewer, "userId" | "sessionId">): string | null {
  if (v.userId) return `u:${v.userId}`;
  if (v.sessionId) return `s:${v.sessionId}`;
  return null;
}

function videoItems(videos: readonly FeedVideo[]): FeedVideoItem[] {
  return videos.map((video) => ({ kind: "video", key: `video:${video.id}`, video }));
}

async function serveKeyset(
  req: FeedRequest,
  viewer: FeedViewer,
  cursor: FeedCursor | null,
  deps: ServeDeps,
): Promise<Omit<FeedResponse, "requestId" | "ab">> {
  let filter: KeysetFilter;
  if (req.creatorId) filter = { kind: "creator", creatorId: req.creatorId };
  else if (req.category) filter = { kind: "category", slug: req.category };
  else filter = { kind: "following", creatorIds: await deps.followed(viewer.userId) };

  const after = cursor?.m === "keyset" ? cursor.k : null;
  const page = await deps.keyset(filter, after, req.limit, viewer.userId);
  let ids = page.ids;
  if (!after && req.pinnedVideoId) ids = [req.pinnedVideoId, ...ids.filter((id) => id !== req.pinnedVideoId)];
  const videos = await deps.hydrate(ids, { userId: viewer.userId, sessionId: viewer.sessionId, softBlock: false });
  const next: FeedCursor | null = page.next ? { v: 1, m: "keyset", seed: 0, s: null, o: 0, p: 0, k: page.next } : null;
  return { items: videoItems(videos), videos, nextCursor: next ? encodeCursor(next) : null, hasMore: Boolean(next) };
}

export async function serveFeed(req: FeedRequest, viewer: FeedViewer, deps: ServeDeps = defaultServeDeps): Promise<FeedResponse> {
  const requestId = deps.requestId();
  const cursor = decodeCursor(req.cursor);

  if (req.creatorId || req.category || req.source === "following") {
    return { ...(await serveKeyset(req, viewer, cursor, deps)), requestId, ab: null };
  }

  const identity = viewerIdentity(viewer);
  const { config, ab } = await deps.config(identity);
  const page = await rankedPage(
    { identity, userId: viewer.userId, cfg: config, cursor, limit: req.limit, pinnedVideoId: req.pinnedVideoId },
    deps,
  );
  const videos = await deps.hydrate(page.ids, {
    userId: viewer.userId,
    sessionId: viewer.sessionId,
    softBlock: !req.includeSoftCommerce,
  });
  if (identity) await deps.store.markSeen(identity, videos.map((v) => v.id), config.rank_seen_ttl_s, config.rank_seen_max);

  const startPos = cursor?.m === "rank" ? cursor.p : 0;
  const rules = await deps.slots();
  const maxCards = rules.reduce((n, r) => n + (r.enabled ? r.maxPerPage : 0), 0);
  const demand = cardDemand(rules, startPos, videos.length + maxCards);
  const pools = demand.size > 0 && videos.length > 0 ? await deps.cards(demand, { locale: viewer.locale }) : new Map();
  const { items, nextPos } = interleave({ videos: videoItems(videos), rules, pools, startPos });

  const next: FeedCursor | null = page.hasMore
    ? { v: 1, m: "rank", seed: page.seed, s: page.snapId, o: page.nextOffset, p: nextPos, k: null }
    : null;
  return { items, videos, nextCursor: next ? encodeCursor(next) : null, hasMore: Boolean(next), requestId, ab };
}
