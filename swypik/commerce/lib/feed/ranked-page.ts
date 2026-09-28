/**
 * For You: lista clasată (snapshot) + pagina curentă din ea.
 *
 *   - prima pagină: candidați fără clipurile deja servite (seen-set Redis) →
 *     scor → explorare → diversitate → snapshot (Redis, TTL) → primele `limit`;
 *     dacă nu mai există destule clipuri nevăzute, se reciclează cele văzute
 *     (feed-ul nu se termină brusc pe un catalog mic);
 *   - paginile următoare: continuă snapshot-ul din cursor. Snapshot expirat →
 *     clasament nou fără seen; fără Redis → clasamentul se recalculează identic
 *     din `seed` și se continuă de la offset.
 */
import crypto from "crypto";
import type { RankConfig } from "./config";
import type { FeedCursor } from "./cursor";
import { seededRng } from "./bandit";
import type { CandidateContext, MergedCandidate } from "./candidates";
import { rankCandidates } from "./rank";
import { EMPTY_STATS, type Candidate, type VideoStats } from "./scoring";
import type { FeedStore } from "./store";

export type RankedPageDeps = {
  store: FeedStore;
  generate: (ctx: CandidateContext) => Promise<MergedCandidate[]>;
  stats: (ids: readonly string[]) => Promise<Map<string, VideoStats>>;
  followed: (userId: string | null) => Promise<string[]>;
  now: () => Date;
  randomSeed: () => number;
};

export type RankedPageInput = {
  identity: string | null;
  userId: string | null;
  cfg: RankConfig;
  cursor: FeedCursor | null;
  limit: number;
  pinnedVideoId?: string;
};

export type RankedPage = { ids: string[]; seed: number; snapId: string; nextOffset: number; hasMore: boolean };

export function newSnapshotId(): string {
  return crypto.randomBytes(9).toString("base64url");
}

async function buildRankedIds(
  input: RankedPageInput,
  deps: RankedPageDeps,
  seed: number,
  exclude: readonly string[],
  followed: readonly string[],
): Promise<string[]> {
  const cands = await deps.generate({ userId: input.userId, exclude, followedCreatorIds: followed, cfg: input.cfg });
  if (cands.length === 0) return [];
  const statsMap = await deps.stats(cands.map((c) => c.id));
  const followedSet = new Set(followed);
  const full: Candidate[] = cands.map((c) => ({
    id: c.id,
    creatorId: c.creatorId,
    publishedAt: c.publishedAt,
    durationMs: c.durationMs,
    sources: c.sources,
    topicAffinity: c.affinity,
    viewerFollows: c.creatorId !== null && followedSet.has(c.creatorId),
    stats: statsMap.get(c.id) ?? EMPTY_STATS,
  }));
  return rankCandidates(full, input.cfg, deps.now(), seededRng(seed))
    .slice(0, Math.max(1, Math.trunc(input.cfg.rank_snapshot_size)))
    .map((r) => r.id);
}

export async function rankedPage(input: RankedPageInput, deps: RankedPageDeps): Promise<RankedPage> {
  const { identity, cursor, cfg, limit } = input;
  const rankCursor = cursor?.m === "rank" ? cursor : null;
  const seed = rankCursor?.seed ?? deps.randomSeed();
  let snapId = rankCursor?.s ?? null;
  let offset = rankCursor?.o ?? 0;
  let ids: string[] | null = null;

  if (identity && snapId) {
    ids = await deps.store.loadSnapshot(identity, snapId);
    if (ids && offset >= ids.length) ids = null;
  }

  if (!ids) {
    const seen = identity ? await deps.store.getSeen(identity, cfg.rank_seen_max) : [];
    const followed = await deps.followed(input.userId);
    ids = await buildRankedIds(input, deps, seed, seen, followed);
    if (!rankCursor && ids.length < limit && seen.length > 0) {
      const recycled = await buildRankedIds(input, deps, seed, ids, followed);
      const have = new Set(ids);
      ids = [...ids, ...recycled.filter((id) => !have.has(id))];
    }
    // Fără seen-set (fără Redis / anonim fără sesiune) clasamentul e determinist din seed.
    offset = rankCursor && seen.length === 0 ? Math.min(rankCursor.o, ids.length) : 0;
    if (!rankCursor && input.pinnedVideoId) {
      ids = [input.pinnedVideoId, ...ids.filter((id) => id !== input.pinnedVideoId)];
    }
    snapId = newSnapshotId();
    if (identity && ids.length > 0) await deps.store.saveSnapshot(identity, snapId, ids, cfg.rank_snapshot_ttl_s);
  }

  const page = ids.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const hasMore = page.length > 0 && (nextOffset < ids.length || ids.length >= cfg.rank_snapshot_size);
  return { ids: page, seed, snapId: snapId ?? newSnapshotId(), nextOffset, hasMore };
}
