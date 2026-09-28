/**
 * Scorul unui clip candidat — pur, testat (tests/unit/feed-rank.test.ts).
 *
 *   value = Σ w_i · rate_i (rate netezite bayesian pe impresii distincte)
 *         + w_watch · watchShare − w_skip · pSkip − w_negative · pNegative
 *         + w_recency · 2^(−vârstă / half-life)
 *         + w_following · [urmărește creatorul] + w_topic · afinitate_topic
 *
 * Ratele (nu contoarele brute) nu mai favorizează clipurile vechi, foarte expuse;
 * netezirea (x + prior·k) / (n + k) ține clipurile cu 3 impresii aproape de
 * media platformei până acumulează date.
 */
import type { RankConfig } from "./config";

export type VideoStats = {
  impressions: number;
  viewers: number;
  completions: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  follows: number;
  skips: number;
  negatives: number;
  watchMs: number;
};

export const EMPTY_STATS: VideoStats = {
  impressions: 0,
  viewers: 0,
  completions: 0,
  likes: 0,
  comments: 0,
  shares: 0,
  saves: 0,
  follows: 0,
  skips: 0,
  negatives: 0,
  watchMs: 0,
};

export type CandidateSource = "following" | "fresh" | "trending" | "topic" | "explore" | "backfill" | "embedding";

export type Candidate = {
  id: string;
  creatorId: string | null;
  publishedAt: Date;
  durationMs: number | null;
  sources: Set<CandidateSource>;
  /** 0..1 — potrivirea cu interesele explicite ale viewerului. */
  topicAffinity: number;
  viewerFollows: boolean;
  stats: VideoStats;
};

export type ScoreParts = {
  engagement: number;
  watch: number;
  negative: number;
  recency: number;
  personal: number;
};

export function smoothedRate(count: number, n: number, prior: number, strength: number): number {
  const k = Math.max(0, strength);
  const denom = Math.max(0, n) + k;
  if (denom <= 0) return 0;
  return (Math.max(0, count) + prior * k) / denom;
}

/** Fracțiunea medie vizionată per viewer (0..1.5); 0 dacă durata e necunoscută. */
export function watchShare(stats: VideoStats, durationMs: number | null): number {
  if (!durationMs || durationMs <= 0 || stats.viewers <= 0) return 0;
  return Math.min(1.5, stats.watchMs / (durationMs * stats.viewers));
}

export function recencyDecay(ageHours: number, halfLifeHours: number): number {
  if (!Number.isFinite(ageHours) || halfLifeHours <= 0) return 0;
  return Math.pow(2, -Math.max(0, ageHours) / halfLifeHours);
}

export function scoreCandidate(c: Candidate, cfg: RankConfig, now: Date): { score: number; parts: ScoreParts } {
  const s = c.stats;
  const n = s.impressions;
  const k = cfg.rank_prior_strength;
  const rate = (x: number, prior: number) => smoothedRate(x, n, prior, k);

  const engagement =
    cfg.rank_w_complete * rate(s.completions, cfg.rank_prior_complete) +
    cfg.rank_w_like * rate(s.likes, cfg.rank_prior_like) +
    cfg.rank_w_comment * rate(s.comments, cfg.rank_prior_comment) +
    cfg.rank_w_share * rate(s.shares, cfg.rank_prior_share) +
    cfg.rank_w_save * rate(s.saves, cfg.rank_prior_save) +
    cfg.rank_w_follow * rate(s.follows, cfg.rank_prior_follow);
  const watch = cfg.rank_w_watch * watchShare(s, c.durationMs);
  const negative =
    cfg.rank_w_skip * rate(s.skips, cfg.rank_prior_skip) + cfg.rank_w_negative * rate(s.negatives, cfg.rank_prior_negative);
  const ageHours = (now.getTime() - c.publishedAt.getTime()) / 3_600_000;
  const recency = cfg.rank_w_recency * recencyDecay(ageHours, cfg.rank_recency_half_life_h);
  const personal =
    (c.viewerFollows ? cfg.rank_w_following : 0) + cfg.rank_w_topic * Math.max(0, Math.min(1, c.topicAffinity));

  const score = engagement + watch - negative + recency + personal;
  return { score, parts: { engagement, watch, negative, recency, personal } };
}

/** Clip „nou” = eligibil pentru pool-ul de explorare al banditului. */
export function isExplorationCandidate(c: Candidate, cfg: RankConfig, now: Date): boolean {
  const ageHours = (now.getTime() - c.publishedAt.getTime()) / 3_600_000;
  return ageHours <= cfg.rank_explore_max_age_h && c.stats.impressions < cfg.rank_explore_max_impressions;
}
