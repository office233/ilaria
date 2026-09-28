/**
 * Configurația ranker-ului — fără redeploy.
 *
 * Prioritate: `feed_weights` (DB, chei `rank_*`) > env `FEED_RANK_<KEY>` >
 * valorile implicite de mai jos. A/B: chei `b:rank_*` în feed_weights,
 * split determinist pe viewer (FNV-1a % 100 < FEED_AB_PERCENT).
 * Cache 60s per proces.
 */
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";

export const DEFAULT_RANK_CONFIG = {
  // ── ponderile scorului (rate netezite, 0..1) ──
  rank_w_complete: 30,
  rank_w_watch: 20,
  rank_w_like: 25,
  rank_w_comment: 30,
  rank_w_share: 40,
  rank_w_save: 30,
  rank_w_follow: 40,
  rank_w_skip: 25,
  rank_w_negative: 60,
  rank_w_recency: 8,
  rank_w_following: 6,
  rank_w_topic: 5,
  // ── netezire bayesiană: rate = (x + prior·k) / (impresii + k) ──
  rank_prior_strength: 20,
  rank_prior_complete: 0.25,
  rank_prior_like: 0.04,
  rank_prior_comment: 0.005,
  rank_prior_share: 0.005,
  rank_prior_save: 0.01,
  rank_prior_follow: 0.003,
  rank_prior_skip: 0.3,
  rank_prior_negative: 0.005,
  // ── prospețime: decădere exponențială cu timp de înjumătățire (ore) ──
  rank_recency_half_life_h: 36,
  // ── diversitate: max 1 clip per creator în fereastra de N sloturi ──
  rank_creator_window: 4,
  // ── explorare (bandit Thompson pentru clipuri noi) ──
  rank_explore_every: 5,
  rank_explore_epsilon: 0.1,
  rank_explore_max_age_h: 72,
  rank_explore_max_impressions: 200,
  // ── candidați per sursă ──
  rank_cand_following: 150,
  rank_cand_fresh: 150,
  rank_cand_trending: 150,
  rank_cand_topic: 100,
  rank_cand_explore: 100,
  rank_cand_backfill: 200,
  rank_fresh_window_h: 72,
  rank_following_window_d: 30,
  // ── servire ──
  rank_snapshot_size: 200,
  rank_snapshot_ttl_s: 1800,
  rank_seen_ttl_s: 86400,
  rank_seen_max: 2000,
} as const;

export type RankConfigKey = keyof typeof DEFAULT_RANK_CONFIG;
export type RankConfig = Record<RankConfigKey, number>;
export type AbVariant = "a" | "b" | null;

const CACHE_TTL_MS = 60_000;
type Loaded = { base: Partial<RankConfig>; b: Partial<RankConfig>; at: number };
let cache: Loaded | null = null;

function isKey(k: string): k is RankConfigKey {
  return Object.prototype.hasOwnProperty.call(DEFAULT_RANK_CONFIG, k);
}

function envConfig(env: NodeJS.ProcessEnv = process.env): Partial<RankConfig> {
  const out: Partial<RankConfig> = {};
  for (const key of Object.keys(DEFAULT_RANK_CONFIG)) {
    if (!isKey(key)) continue;
    const raw = env[`FEED_${key.toUpperCase()}`];
    if (raw == null || raw === "") continue;
    const n = Number(raw);
    if (Number.isFinite(n)) out[key] = n;
  }
  return out;
}

/** Pură: aplică rândurile din feed_weights peste defaults + env. */
export function mergeRankConfig(
  rows: ReadonlyArray<{ key: string; value: unknown }>,
  env: NodeJS.ProcessEnv = process.env,
): { base: RankConfig; b: Partial<RankConfig> } {
  const base: RankConfig = { ...DEFAULT_RANK_CONFIG, ...envConfig(env) };
  const b: Partial<RankConfig> = {};
  for (const row of rows) {
    const n = Number(row.value);
    if (!Number.isFinite(n)) continue;
    if (row.key.startsWith("b:")) {
      const k = row.key.slice(2);
      if (isKey(k)) b[k] = n;
    } else if (isKey(row.key)) {
      base[row.key] = n;
    }
  }
  return { base, b };
}

async function load(): Promise<Loaded> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache;
  let rows: { key: string; value: unknown }[] = [];
  try {
    const res = await dbQuery<{ key: string; value: unknown }>(
      `SELECT key, value FROM feed_weights WHERE key LIKE 'rank\\_%' OR key LIKE 'b:rank\\_%'`,
    );
    rows = res.rows;
  } catch (err) {
    logger.warn({ err }, "[feed/config] feed_weights unavailable, using env/defaults");
  }
  const merged = mergeRankConfig(rows);
  cache = { base: merged.base, b: merged.b, at: Date.now() };
  return cache;
}

export function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function abPercent(): number {
  const n = Number(process.env.FEED_AB_PERCENT);
  return Number.isFinite(n) && n > 0 && n <= 100 ? Math.trunc(n) : 50;
}

export async function loadRankConfig(viewerKey: string | null): Promise<{ config: RankConfig; ab: AbVariant }> {
  const { base, b } = await load();
  const full = base as RankConfig;
  if (!viewerKey || Object.keys(b).length === 0) return { config: full, ab: null };
  if (fnv1a(viewerKey) % 100 >= abPercent()) return { config: full, ab: "a" };
  return { config: { ...full, ...b }, ab: "b" };
}

/** Doar pentru teste. */
export function _resetRankConfigCache(): void {
  cache = null;
}
