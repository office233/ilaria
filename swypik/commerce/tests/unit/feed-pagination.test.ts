import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({ dbQuery: vi.fn(async () => ({ rows: [], rowCount: 0 })) }));
vi.mock("@/lib/redis", () => ({
  getRedis: () => {
    throw new Error("REDIS_URL is missing");
  },
}));

import { DEFAULT_RANK_CONFIG, type RankConfig } from "@/lib/feed/config";
import { decodeCursor, encodeCursor, type FeedCursor } from "@/lib/feed/cursor";
import { rankedPage, type RankedPageDeps } from "@/lib/feed/ranked-page";
import type { CandidateContext, MergedCandidate } from "@/lib/feed/candidates";
import { createMemoryFeedStore, redisFeedStore, type FeedStore } from "@/lib/feed/store";

const NOW = new Date("2026-09-26T12:00:00Z");
const CFG: RankConfig = { ...DEFAULT_RANK_CONFIG, rank_snapshot_size: 50, rank_explore_epsilon: 0 };
const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

function catalog(n: number): MergedCandidate[] {
  return Array.from({ length: n }, (_, i) => ({
    id: uuid(i + 1),
    creatorId: uuid(1000 + (i % 7)),
    publishedAt: new Date(NOW.getTime() - (i + 1) * 5 * 3_600_000),
    durationMs: 15_000,
    sources: new Set(["backfill" as const]),
    affinity: 0,
  }));
}

function deps(all: MergedCandidate[], store: FeedStore, seeds: number[] = [1234]): RankedPageDeps & { calls: CandidateContext[] } {
  const calls: CandidateContext[] = [];
  let s = 0;
  return {
    calls,
    store,
    generate: async (ctx) => {
      calls.push(ctx);
      const ex = new Set(ctx.exclude);
      return all.filter((c) => !ex.has(c.id));
    },
    stats: async () => new Map(),
    followed: async () => [],
    now: () => NOW,
    randomSeed: () => seeds[s++ % seeds.length],
  };
}

describe("cursor", () => {
  it("round-trip și respingerea cursoarelor invalide", () => {
    const c: FeedCursor = { v: 1, m: "rank", seed: 42, s: "abcdefgh12", o: 12, p: 14, k: null };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expect(decodeCursor("nope")).toBeNull();
    expect(decodeCursor(Buffer.from(JSON.stringify({ ...c, o: -1 })).toString("base64url"))).toBeNull();
    expect(decodeCursor(Buffer.from(JSON.stringify({ ...c, s: "../../x" })).toString("base64url"))).toBeNull();
    const k: FeedCursor = { v: 1, m: "keyset", seed: 0, s: null, o: 0, p: 0, k: { t: "2026-09-26T10:00:00.123456Z", id: uuid(3) } };
    expect(decodeCursor(encodeCursor(k))).toEqual(k);
  });
});

describe("rankedPage — snapshot + cursor", () => {
  it("paginile consecutive nu repetă clipuri și continuă snapshot-ul (o singură generare)", async () => {
    const store = createMemoryFeedStore();
    const d = deps(catalog(30), store);
    const p1 = await rankedPage({ identity: "u:x", userId: null, cfg: CFG, cursor: null, limit: 10 }, d);
    const c1: FeedCursor = { v: 1, m: "rank", seed: p1.seed, s: p1.snapId, o: p1.nextOffset, p: 10, k: null };
    const p2 = await rankedPage({ identity: "u:x", userId: null, cfg: CFG, cursor: c1, limit: 10 }, d);
    const c2: FeedCursor = { ...c1, o: p2.nextOffset };
    const p3 = await rankedPage({ identity: "u:x", userId: null, cfg: CFG, cursor: c2, limit: 10 }, d);
    const all = [...p1.ids, ...p2.ids, ...p3.ids];
    expect(all).toHaveLength(30);
    expect(new Set(all).size).toBe(30);
    expect(d.calls).toHaveLength(1);
    expect(p3.hasMore).toBe(false);
  });

  it("snapshot-ul e legat de identitate: alt viewer cu același cursor primește clasament nou", async () => {
    const store = createMemoryFeedStore();
    const d = deps(catalog(12), store);
    const p1 = await rankedPage({ identity: "u:a", userId: null, cfg: CFG, cursor: null, limit: 5 }, d);
    const cur: FeedCursor = { v: 1, m: "rank", seed: p1.seed, s: p1.snapId, o: 5, p: 5, k: null };
    await rankedPage({ identity: "u:b", userId: null, cfg: CFG, cursor: cur, limit: 5 }, d);
    expect(d.calls).toHaveLength(2);
  });
});

describe("rankedPage — seen-dedupe", () => {
  it("o sesiune nouă exclude clipurile deja servite (seen-set)", async () => {
    const store = createMemoryFeedStore();
    await store.markSeen("s:abc", [uuid(1), uuid(2), uuid(3)], 60, 100);
    const d = deps(catalog(10), store);
    const p = await rankedPage({ identity: "s:abc", userId: null, cfg: CFG, cursor: null, limit: 5 }, d);
    expect(d.calls[0].exclude).toEqual(expect.arrayContaining([uuid(1), uuid(2), uuid(3)]));
    expect(p.ids).not.toContain(uuid(1));
    expect(p.ids).toHaveLength(5);
  });

  it("catalog mic, totul văzut: prima pagină reciclează (feed-ul nu moare), fără duplicate", async () => {
    const store = createMemoryFeedStore();
    const all = catalog(4);
    await store.markSeen("u:z", all.map((c) => c.id), 60, 100);
    const d = deps(all, store);
    const p = await rankedPage({ identity: "u:z", userId: null, cfg: CFG, cursor: null, limit: 10 }, d);
    expect(p.ids.sort()).toEqual(all.map((c) => c.id).sort());
  });

  it("clipul fixat (?v=) vine primul, o singură dată", async () => {
    const d = deps(catalog(8), createMemoryFeedStore());
    const p = await rankedPage({ identity: "u:p", userId: null, cfg: CFG, cursor: null, limit: 8, pinnedVideoId: uuid(5) }, d);
    expect(p.ids[0]).toBe(uuid(5));
    expect(p.ids.filter((id) => id === uuid(5))).toHaveLength(1);
  });

  it("seen-set plafonat: se păstrează cele mai recente", async () => {
    const store = createMemoryFeedStore();
    await store.markSeen("u:m", ["a", "b", "c"], 60, 2);
    expect(await store.getSeen("u:m", 10)).toEqual(["c", "b"]);
  });
});

describe("rankedPage — fără Redis", () => {
  it("store-ul Redis degradează grațios (fără excepții)", async () => {
    expect(await redisFeedStore.getSeen("u:x", 10)).toEqual([]);
    expect(await redisFeedStore.loadSnapshot("u:x", "abcdefgh")).toBeNull();
    await expect(redisFeedStore.markSeen("u:x", ["a"], 60, 10)).resolves.toBeUndefined();
  });

  it("clasamentul se recalculează identic din seed și continuă de la offset", async () => {
    const d = deps(catalog(20), redisFeedStore, [777]);
    const p1 = await rankedPage({ identity: "s:anon", userId: null, cfg: CFG, cursor: null, limit: 8 }, d);
    const cur: FeedCursor = { v: 1, m: "rank", seed: p1.seed, s: p1.snapId, o: p1.nextOffset, p: 8, k: null };
    const p2 = await rankedPage({ identity: "s:anon", userId: null, cfg: CFG, cursor: cur, limit: 8 }, d);
    expect(new Set([...p1.ids, ...p2.ids]).size).toBe(16);
  });
});
