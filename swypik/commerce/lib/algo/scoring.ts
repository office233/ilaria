/**
 * Scoring feed (FRONT 3).
 *
 * Formula:
 *   score = w_freshness  * freshness
 *         + w_engagement * engagement_rate
 *         + w_conversion * conversion_rate
 *         + w_follow_bonus * (viewer urmărește creatorul ? 1 : 0)
 *         - w_saturation * saturation
 *         + equity (boost creator mic <48h, plafon views/zi, rotație)
 *
 * Ponderile vin din tabela `feed_weights` (env fallback FEED_W_* / defaults).
 * Funcția `scoreVideo` este pură — testată în tests/unit/feed-scoring.test.ts.
 */

import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";

export type FeedWeights = {
  w_freshness: number;
  w_engagement: number;
  w_conversion: number;
  w_follow_bonus: number;
  w_saturation: number;
  small_creator_boost: number;
  small_creator_followers: number;
  small_creator_hours: number;
  daily_views_cap: number;
  daily_cap_penalty: number;
  rotation_penalty: number;
  fund_min_watch_ms: number;
  fund_payout_min_cents: number;
  // 2026-08-11 (audit): ponderile engagement din feed-ul explore — tunabile
  // live din feed_weights (DB) fără redeploy, ca restul algoritmului.
  eng_view: number;
  eng_like: number;
  eng_share: number;
  eng_comment: number;
  /** Ponderea similarității semantice (pgvector) cu gustul viewerului. */
  w_taste: number;
  /**
   * Ponderea intereselor EXPLICITE (user_interests: onboarding +
   * more_like_this / not_interested). Rezolvă cold start-ul: funcționează
   * din primul clip, fără embeddings.
   */
  w_interest: number;
  /**
   * Amplitudinea jitterului de explorare (random()*w_explore) din feed-ul
   * explore. 2026-08-24 (audit): 15 îneca personalizarea (interese ≤10,
   * freshness ≤5) — redus la 6, tunabil live fără redeploy.
   */
  w_explore: number;
};

export const DEFAULT_FEED_WEIGHTS: FeedWeights = {
  w_freshness: 1.0,
  w_engagement: 1.0,
  w_conversion: 1.5,
  w_follow_bonus: 3.0,
  w_saturation: 1.0,
  small_creator_boost: 8.0,
  small_creator_followers: 1000,
  small_creator_hours: 48,
  daily_views_cap: 20000,
  daily_cap_penalty: 25,
  rotation_penalty: 6,
  fund_min_watch_ms: 3000,
  fund_payout_min_cents: 1000,
  eng_view: 1,
  eng_like: 5,
  eng_share: 10,
  eng_comment: 3,
  w_taste: 12,
  w_interest: 10,
  w_explore: 6,
};

function envOverride(key: keyof FeedWeights, fallback: number): number {
  const raw = process.env[`FEED_${key.toUpperCase()}`];
  if (raw == null) return fallback;
  const num = Number(raw);
  return Number.isFinite(num) ? num : fallback;
}

let cache: { weights: FeedWeights; loadedAt: number } | null = null;
const CACHE_TTL_MS = 60_000;

/** Ponderi: feed_weights (DB) > env FEED_<KEY> > defaults. Cache 60s. */
export async function loadFeedWeights(): Promise<FeedWeights> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) return cache.weights;

  const weights: FeedWeights = { ...DEFAULT_FEED_WEIGHTS };
  for (const key of Object.keys(weights) as Array<keyof FeedWeights>) {
    weights[key] = envOverride(key, weights[key]);
  }
  try {
    const { rows } = await dbQuery<{ key: string; value: string }>(
      `SELECT key, value FROM feed_weights`
    );
    for (const row of rows) {
      if (row.key in weights) {
        const num = Number(row.value);
        if (Number.isFinite(num)) weights[row.key as keyof FeedWeights] = num;
      }
    }
  } catch (err) {
    logger.warn({ err }, "[algo] feed_weights unavailable, using env/defaults");
  }
  cache = { weights, loadedAt: Date.now() };
  return weights;
}

/** Doar pentru teste. */
export function _clearFeedWeightsCache(): void {
  cache = null;
}

// ---------- A/B testing pe ponderi (2026-08-11) ----------
//
// Varianta B: chei `b:<weight_key>` în feed_weights (ex. `b:w_taste` = 20).
// Split determinist pe viewer (hash FNV-1a pe userId/sessionId, % 100 <
// FEED_AB_PERCENT → varianta B). Fără chei b:* în DB, A/B e inert.
// Expunerea variantei se întoarce ca `abVariant` pentru logging/analiză.

const AB_PERCENT = (() => {
  const n = Number(process.env.FEED_AB_PERCENT);
  return Number.isFinite(n) && n > 0 && n <= 100 ? Math.trunc(n) : 50;
})();

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

let bCache: { overrides: Partial<Record<keyof FeedWeights, number>>; loadedAt: number } | null = null;

async function loadBOverrides(): Promise<Partial<Record<keyof FeedWeights, number>>> {
  if (bCache && Date.now() - bCache.loadedAt < CACHE_TTL_MS) return bCache.overrides;
  const overrides: Partial<Record<keyof FeedWeights, number>> = {};
  try {
    const { rows } = await dbQuery<{ key: string; value: string }>(
      `SELECT key, value FROM feed_weights WHERE key LIKE 'b:%'`
    );
    for (const row of rows) {
      const k = row.key.slice(2) as keyof FeedWeights;
      const num = Number(row.value);
      if (k in DEFAULT_FEED_WEIGHTS && Number.isFinite(num)) overrides[k] = num;
    }
  } catch {
    /* fara tabel/chei — A/B inert */
  }
  bCache = { overrides, loadedAt: Date.now() };
  return overrides;
}

export type AbFeedWeights = { weights: FeedWeights; abVariant: "a" | "b" | null };

/**
 * Ponderi cu A/B: viewerul primește determinist varianta A (baseline) sau B
 * (override-uri `b:*` din feed_weights). Fără override-uri → abVariant null.
 */
export async function loadFeedWeightsForViewer(
  viewerKey: string | null,
): Promise<AbFeedWeights> {
  const weights = await loadFeedWeights();
  if (!viewerKey) return { weights, abVariant: null };
  const overrides = await loadBOverrides();
  if (Object.keys(overrides).length === 0) return { weights, abVariant: null };
  const inB = fnv1a(viewerKey) % 100 < AB_PERCENT;
  if (!inB) return { weights, abVariant: "a" };
  return { weights: { ...weights, ...overrides }, abVariant: "b" };
}

export type VideoScoringInput = {
  /** Vârsta clipului în ore (de la published_at). */
  ageHours: number;
  /** (likes+saves+2*shares+comments) / max(views,1) — 0..∞, tipic 0..1. */
  engagementRate: number;
  /** (purchases + 0.3*add_to_cart) / max(views,1). */
  conversionRate: number;
  /** Viewerul urmărește creatorul. */
  viewerFollowsCreator: boolean;
  /** Câte clipuri ale ACESTUI creator a văzut viewerul deja azi. */
  creatorServedToViewerToday: number;
  /** Followers ai creatorului. */
  creatorFollowers: number;
  /** Vizualizări totale primite azi de creator (toate clipurile lui). */
  creatorViewsToday: number;
};

export type VideoScore = {
  score: number;
  parts: {
    freshness: number;
    engagement: number;
    conversion: number;
    followBonus: number;
    saturation: number;
    smallCreatorBoost: number;
    dailyCapPenalty: number;
  };
};

/**
 * Freshness: 5 la publicare, decade exponențial (half-life ~24h), ~0 după 5 zile.
 */
export function freshnessSignal(ageHours: number): number {
  if (!Number.isFinite(ageHours) || ageHours < 0) return 0;
  return 5 * Math.exp(-ageHours / 34.6); // half-life 24h: ln2/24 ≈ 1/34.6
}

/** Funcție pură de scoring — echitate inclusă. */
export function scoreVideo(input: VideoScoringInput, w: FeedWeights): VideoScore {
  const freshness = freshnessSignal(input.ageHours);
  // Comprimăm engagementul ca să nu domine clipurile virale la nesfârșit.
  const engagement = Math.log1p(Math.max(0, input.engagementRate) * 100); // 0..~7
  const conversion = Math.log1p(Math.max(0, input.conversionRate) * 100); // 0..~7
  const followBonus = input.viewerFollowsCreator ? 1 : 0;

  // ECHITATE 1 — rotație: fiecare clip deja servit azi de la același creator
  // penalizează următoarele (nu domină aceiași creatori un feed).
  const saturation =
    Math.max(0, input.creatorServedToViewerToday) * w.rotation_penalty;

  // ECHITATE 2 — boost creatori mici: clip < small_creator_hours vechime,
  // creator cu < small_creator_followers followers.
  const isSmallCreator = input.creatorFollowers < w.small_creator_followers;
  const isFreshVideo = input.ageHours < w.small_creator_hours;
  const smallCreatorBoost =
    isSmallCreator && isFreshVideo ? w.small_creator_boost : 0;

  // ECHITATE 3 — plafon vizualizări/zi per business: peste plafon, clipurile
  // creatorului sunt retrogradate (nu eliminate) pentru restul zilei.
  const dailyCapPenalty =
    input.creatorViewsToday > w.daily_views_cap ? w.daily_cap_penalty : 0;

  const score =
    w.w_freshness * freshness +
    w.w_engagement * engagement +
    w.w_conversion * conversion +
    w.w_follow_bonus * followBonus -
    w.w_saturation * saturation +
    smallCreatorBoost -
    dailyCapPenalty;

  return {
    score,
    parts: {
      freshness,
      engagement,
      conversion,
      followBonus,
      saturation,
      smallCreatorBoost,
      dailyCapPenalty,
    },
  };
}

/**
 * Expresie SQL echivalentă (parametrizată cu ponderile), pentru folosire
 * directă în ORDER BY. $W este înlocuit cu valorile numerice validate
 * (toate provin din feed_weights/env — numeric, nu user input).
 */
export function buildScoreSql(w: FeedWeights, opts: {
  followsJoinAlias?: string | null;
  servedCountExpr?: string;
  creatorViewsTodayExpr?: string;
}): string {
  const n = (v: number) => {
    if (!Number.isFinite(v)) throw new Error("non-finite feed weight");
    return String(v);
  };
  const follows = opts.followsJoinAlias
    ? `CASE WHEN ${opts.followsJoinAlias}.follower_user_id IS NOT NULL THEN 1 ELSE 0 END`
    : "0";
  const served = opts.servedCountExpr ?? "0";
  const creatorViews = opts.creatorViewsTodayExpr ?? "0";

  return `(
    ${n(w.w_freshness)} * (5 * EXP(-GREATEST(EXTRACT(EPOCH FROM (NOW() - COALESCE(v.published_at, v.created_at))) / 3600.0, 0) / 34.6))
    + ${n(w.w_engagement)} * LN(1 + ((v.like_count + v.save_count + 2 * v.share_count + v.comment_count)::numeric / GREATEST(v.view_count, 1)) * 100)
    + ${n(w.w_conversion)} * LN(1 + (COALESCE(conv.conv_rate, 0)) * 100)
    + ${n(w.w_follow_bonus)} * (${follows})
    - ${n(w.w_saturation)} * ((${served}) * ${n(w.rotation_penalty)})
    + CASE WHEN COALESCE(cf.follower_count, 0) < ${n(w.small_creator_followers)}
             AND COALESCE(v.published_at, v.created_at) > NOW() - INTERVAL '1 hour' * ${n(w.small_creator_hours)}
           THEN ${n(w.small_creator_boost)} ELSE 0 END
    - CASE WHEN (${creatorViews}) > ${n(w.daily_views_cap)} THEN ${n(w.daily_cap_penalty)} ELSE 0 END
  )`;
}
