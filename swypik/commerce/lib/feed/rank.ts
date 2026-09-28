/**
 * Ordonarea finală a candidaților — pur și determinist (seed → aceeași ordine).
 *   1. exploatare: scor descrescător (scoring.ts);
 *   2. explorare: fiecare al `rank_explore_every`-lea slot (+ ε aleator) merge
 *      la un clip nou ales prin Thompson sampling (bandit.ts);
 *   3. diversitate: niciun creator de două ori în `rank_creator_window` sloturi
 *      consecutive (dacă se poate).
 */
import type { RankConfig } from "./config";
import { thompsonPick, type Rng } from "./bandit";
import { isExplorationCandidate, scoreCandidate, type Candidate } from "./scoring";

export type RankedCandidate = { id: string; creatorId: string | null; score: number; explored: boolean };

export function orderByScore(cands: readonly Candidate[], cfg: RankConfig, now: Date): RankedCandidate[] {
  return cands
    .map((c) => ({ id: c.id, creatorId: c.creatorId, score: scoreCandidate(c, cfg, now).score, explored: false }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

export function mixExploration(
  cands: readonly Candidate[],
  cfg: RankConfig,
  now: Date,
  rng: Rng,
): RankedCandidate[] {
  const exploit = orderByScore(cands, cfg, now);
  const scoreById = new Map(exploit.map((r) => [r.id, r.score]));
  const pool = cands.filter((c) => isExplorationCandidate(c, cfg, now));
  const used = new Set<string>();
  const out: RankedCandidate[] = [];
  const every = Math.max(0, Math.trunc(cfg.rank_explore_every));
  const epsilon = Math.max(0, Math.min(1, cfg.rank_explore_epsilon));
  let ei = 0;

  while (out.length < cands.length) {
    const slot = out.length + 1;
    const wantExplore = (every > 0 && slot % every === 0) || rng() < epsilon;
    const remainingPool = pool.filter((c) => !used.has(c.id));
    if (wantExplore && remainingPool.length > 0) {
      const arms = remainingPool.map((c) => ({ id: c.id, successes: c.stats.completions, trials: c.stats.impressions }));
      const pick = remainingPool[thompsonPick(arms, rng)];
      used.add(pick.id);
      out.push({ id: pick.id, creatorId: pick.creatorId, score: scoreById.get(pick.id) ?? 0, explored: true });
      continue;
    }
    while (ei < exploit.length && used.has(exploit[ei].id)) ei++;
    if (ei >= exploit.length) break;
    used.add(exploit[ei].id);
    out.push(exploit[ei]);
  }
  return out;
}

/** Greedy: primul rămas al cărui creator nu apare în ultimele window−1 poziții. */
export function diversify<T extends { creatorId: string | null }>(ordered: readonly T[], window: number): T[] {
  const w = Math.max(1, Math.trunc(window));
  const remaining = [...ordered];
  const out: T[] = [];
  while (remaining.length > 0) {
    const recent = new Set(w > 1 ? out.slice(-(w - 1)).map((x) => x.creatorId) : []);
    let idx = remaining.findIndex((x) => x.creatorId === null || !recent.has(x.creatorId));
    if (idx < 0) idx = 0;
    out.push(remaining[idx]);
    remaining.splice(idx, 1);
  }
  return out;
}

export function rankCandidates(cands: readonly Candidate[], cfg: RankConfig, now: Date, rng: Rng): RankedCandidate[] {
  return diversify(mixExploration(cands, cfg, now, rng), cfg.rank_creator_window);
}
