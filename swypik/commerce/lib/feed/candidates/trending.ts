/**
 * Sursa „trending”: rata de engagement pe 7 zile (MV video_stats_7d, actori
 * distincți — 20260926_0132), netezită ca să nu câștige clipurile cu 2 impresii.
 */
import { runCandidateQuery, type CandidateContext, type CandidateHit } from "./common";

export function trendingCandidates(ctx: CandidateContext): Promise<CandidateHit[]> {
  return runCandidateQuery(ctx, "trending", (bind) => ({
    from: "videos v JOIN video_stats_7d st ON st.video_id = v.id",
    extraWhere: "AND st.impressions > 0",
    orderBy: `((st.completions + st.likes + 2 * st.shares + 2 * st.saves + 3 * st.follows - st.skips - 5 * st.negatives)::float
      / (st.impressions + ${bind(ctx.cfg.rank_prior_strength)}::float)) DESC, v.id DESC`,
    limit: ctx.cfg.rank_cand_trending,
  }));
}
