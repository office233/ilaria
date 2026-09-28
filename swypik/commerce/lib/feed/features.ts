/**
 * Etapa 2 (features): statistici pe 7 zile per clip din MV `video_stats_7d`
 * (actori/sesiuni distincte — un spammer nu poate umfla o rată) + creatorii
 * urmăriți de viewer. Lipsa MV-ului (înainte de migrare) → statistici zero.
 */
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import { EMPTY_STATS, type VideoStats } from "./scoring";

type StatsRow = {
  video_id: string;
  impressions: number | string;
  viewers: number | string;
  completions: number | string;
  likes: number | string;
  comments: number | string;
  shares: number | string;
  saves: number | string;
  follows: number | string;
  skips: number | string;
  negatives: number | string;
  watch_ms: number | string;
};

export function toVideoStats(r: StatsRow): VideoStats {
  const n = (x: number | string) => Math.max(0, Number(x) || 0);
  return {
    impressions: n(r.impressions),
    viewers: n(r.viewers),
    completions: n(r.completions),
    likes: n(r.likes),
    comments: n(r.comments),
    shares: n(r.shares),
    saves: n(r.saves),
    follows: n(r.follows),
    skips: n(r.skips),
    negatives: n(r.negatives),
    watchMs: n(r.watch_ms),
  };
}

export async function loadVideoStats(ids: readonly string[]): Promise<Map<string, VideoStats>> {
  const out = new Map<string, VideoStats>();
  if (ids.length === 0) return out;
  try {
    const { rows } = await dbQuery<StatsRow>(
      `SELECT video_id::text AS video_id, impressions, viewers, completions, likes, comments, shares,
              saves, follows, skips, negatives, watch_ms
         FROM video_stats_7d WHERE video_id = ANY($1::uuid[])`,
      [ids],
    );
    for (const r of rows) out.set(String(r.video_id), toVideoStats(r));
  } catch (err) {
    logger.warn({ err }, "[feed/features] video_stats_7d unavailable");
  }
  return out;
}

export function statsFor(map: ReadonlyMap<string, VideoStats>, id: string): VideoStats {
  return map.get(id) ?? EMPTY_STATS;
}

/** Creatorii urmăriți (plafonat) — pentru sursa following și bonusul personal. */
export async function loadFollowedCreators(userId: string | null, max = 2000): Promise<string[]> {
  if (!userId) return [];
  try {
    const { rows } = await dbQuery<{ id: string }>(
      `SELECT following_user_id::text AS id FROM follows WHERE follower_user_id = $1::uuid LIMIT $2`,
      [userId, max],
    );
    return rows.map((r) => String(r.id));
  } catch (err) {
    logger.warn({ err }, "[feed/features] follows unavailable");
    return [];
  }
}
