import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({ dbQuery: vi.fn(async () => ({ rows: [], rowCount: 0 })) }));

import { DEFAULT_RANK_CONFIG, mergeRankConfig, type RankConfig } from "@/lib/feed/config";
import { EMPTY_STATS, recencyDecay, scoreCandidate, smoothedRate, watchShare, type Candidate, type VideoStats } from "@/lib/feed/scoring";
import { sampleBeta, seededRng, thompsonPick } from "@/lib/feed/bandit";
import { diversify, mixExploration, orderByScore, rankCandidates } from "@/lib/feed/rank";

const CFG: RankConfig = { ...DEFAULT_RANK_CONFIG };
const NOW = new Date("2026-09-26T12:00:00Z");

function cand(id: string, over: Partial<Omit<Candidate, "stats">> & { stats?: Partial<VideoStats> } = {}): Candidate {
  return {
    id,
    creatorId: over.creatorId ?? `c-${id}`,
    publishedAt: over.publishedAt ?? new Date(NOW.getTime() - 10 * 24 * 3_600_000),
    durationMs: over.durationMs ?? 20_000,
    sources: over.sources ?? new Set(["backfill"]),
    topicAffinity: over.topicAffinity ?? 0,
    viewerFollows: over.viewerFollows ?? false,
    stats: { ...EMPTY_STATS, ...(over.stats ?? {}) },
  };
}

describe("config", () => {
  it("DB > env > defaults; chei b: separate; chei necunoscute ignorate", () => {
    const { base, b } = mergeRankConfig(
      [
        { key: "rank_w_share", value: "50" },
        { key: "b:rank_w_share", value: 70 },
        { key: "w_taste", value: 3 },
        { key: "rank_w_like", value: "nan" },
      ],
      { FEED_RANK_W_LIKE: "11", FEED_RANK_W_SHARE: "99" } as unknown as NodeJS.ProcessEnv,
    );
    expect(base.rank_w_share).toBe(50);
    expect(base.rank_w_like).toBe(11);
    expect(b).toEqual({ rank_w_share: 70 });
    expect("w_taste" in base).toBe(false);
  });
});

describe("scoring", () => {
  it("netezirea bayesiană trage ratele cu puține impresii spre prior", () => {
    expect(smoothedRate(0, 0, 0.25, 20)).toBeCloseTo(0.25);
    expect(smoothedRate(2, 2, 0.25, 20)).toBeLessThan(0.35);
    expect(smoothedRate(900, 1000, 0.25, 20)).toBeGreaterThan(0.88);
  });

  it("ratele, nu contoarele: 50/100 bate 200/10000", () => {
    const small = cand("a", { stats: { impressions: 100, completions: 50, likes: 20 } });
    const big = cand("b", { stats: { impressions: 10_000, completions: 200, likes: 300 } });
    expect(scoreCandidate(small, CFG, NOW).score).toBeGreaterThan(scoreCandidate(big, CFG, NOW).score);
  });

  it("feedback negativ și skip-uri scad scorul", () => {
    const ok = cand("a", { stats: { impressions: 200, completions: 60 } });
    const bad = cand("b", { stats: { impressions: 200, completions: 60, skips: 150, negatives: 30 } });
    expect(scoreCandidate(bad, CFG, NOW).score).toBeLessThan(scoreCandidate(ok, CFG, NOW).score);
  });

  it("prospețimea decade exponențial (half-life)", () => {
    expect(recencyDecay(0, 36)).toBe(1);
    expect(recencyDecay(36, 36)).toBeCloseTo(0.5);
    const fresh = cand("a", { publishedAt: new Date(NOW.getTime() - 3_600_000) });
    const old = cand("b");
    expect(scoreCandidate(fresh, CFG, NOW).parts.recency).toBeGreaterThan(scoreCandidate(old, CFG, NOW).parts.recency);
  });

  it("watch share: 0 fără durată; plafonat la 1.5", () => {
    expect(watchShare({ ...EMPTY_STATS, viewers: 2, watchMs: 30_000 }, null)).toBe(0);
    expect(watchShare({ ...EMPTY_STATS, viewers: 1, watchMs: 100_000 }, 10_000)).toBe(1.5);
  });

  it("bonus personal: urmărire + afinitate de topic", () => {
    const base = scoreCandidate(cand("a"), CFG, NOW).score;
    expect(scoreCandidate(cand("a", { viewerFollows: true, topicAffinity: 1 }), CFG, NOW).score).toBeCloseTo(
      base + CFG.rank_w_following + CFG.rank_w_topic,
    );
  });
});

describe("bandit", () => {
  it("RNG-ul cu seed e determinist", () => {
    const a = seededRng(42);
    const b = seededRng(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it("Beta(α,β) are media α/(α+β)", () => {
    const rng = seededRng(7);
    let sum = 0;
    for (let i = 0; i < 4000; i++) sum += sampleBeta(8, 2, rng);
    expect(sum / 4000).toBeCloseTo(0.8, 1);
  });

  it("Thompson alege mai des brațul mai bun", () => {
    const rng = seededRng(1);
    let good = 0;
    for (let i = 0; i < 500; i++) {
      if (thompsonPick([{ id: "bad", successes: 5, trials: 100 }, { id: "good", successes: 60, trials: 100 }], rng) === 1) good++;
    }
    expect(good).toBeGreaterThan(450);
    expect(thompsonPick([], rng)).toBe(-1);
  });
});

describe("rank", () => {
  it("fiecare al N-lea slot merge la un clip nou (explorare)", () => {
    const cfg = { ...CFG, rank_explore_every: 3, rank_explore_epsilon: 0 };
    const oldOnes = Array.from({ length: 6 }, (_, i) => cand(`old${i}`, { stats: { impressions: 1000, completions: 500 - i } }));
    const fresh = cand("new", { publishedAt: new Date(NOW.getTime() - 3_600_000) });
    const out = mixExploration([...oldOnes, fresh], cfg, NOW, seededRng(3));
    expect(out[2].id).toBe("new");
    expect(out[2].explored).toBe(true);
    expect(out).toHaveLength(7);
  });

  it("fără clipuri noi, ordinea = scorul", () => {
    const cfg = { ...CFG, rank_explore_epsilon: 0 };
    const list = [cand("a", { stats: { impressions: 500, completions: 10 } }), cand("b", { stats: { impressions: 500, completions: 300 } })];
    expect(mixExploration(list, cfg, NOW, seededRng(1)).map((r) => r.id)).toEqual(orderByScore(list, cfg, NOW).map((r) => r.id));
  });

  it("diversitate: niciun creator de două ori în fereastră (când se poate)", () => {
    const ordered = [
      { id: "1", creatorId: "A" },
      { id: "2", creatorId: "A" },
      { id: "3", creatorId: "A" },
      { id: "4", creatorId: "B" },
      { id: "5", creatorId: "C" },
    ];
    expect(diversify(ordered, 3).map((x) => x.id)).toEqual(["1", "4", "5", "2", "3"]);
    expect(diversify(ordered, 1).map((x) => x.id)).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("clasamentul e determinist pentru același seed", () => {
    const list = Array.from({ length: 12 }, (_, i) =>
      cand(`v${i}`, { creatorId: `c${i % 3}`, publishedAt: new Date(NOW.getTime() - i * 3_600_000) }),
    );
    const a = rankCandidates(list, CFG, NOW, seededRng(99)).map((r) => r.id);
    const b = rankCandidates(list, CFG, NOW, seededRng(99)).map((r) => r.id);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(12);
  });
});
