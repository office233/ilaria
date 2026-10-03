/**
 * Sursa „explore”: clipuri noi (vârstă ≤ rank_explore_max_age_h) cu puține
 * impresii — pool-ul banditului Thompson (lib/feed/bandit.ts). Clipurile fără
 * rând în MV au 0 impresii.
 */
import { runCandidateQuery, type CandidateContext, type CandidateHit } from "./common";

export function exploreCandidates(ctx: CandidateContext): Promise<CandidateHit[]> {
  return runCandidateQuery(ctx, "explore", (bind) => ({
    from: "videos v LEFT JOIN video_stats_7d st ON st.video_id = v.id",
    extraWhere: `AND COALESCE(v.published_at, v.created_at) > NOW() - make_interval(hours => ${bind(Math.trunc(ctx.cfg.rank_explore_max_age_h))}::int)
      AND COALESCE(st.impressions, 0) < ${bind(Math.trunc(ctx.cfg.rank_explore_max_impressions))}::int`,
    orderBy: "COALESCE(st.impressions, 0) ASC, COALESCE(v.published_at, v.created_at) DESC, v.id DESC",
    limit: ctx.cfg.rank_cand_explore,
  }));
}
