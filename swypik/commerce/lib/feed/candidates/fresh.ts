/** Sursa „fresh”: cele mai noi clipuri din fereastra de prospețime. */
import { runCandidateQuery, type CandidateContext, type CandidateHit } from "./common";

export function freshCandidates(ctx: CandidateContext): Promise<CandidateHit[]> {
  return runCandidateQuery(ctx, "fresh", (bind) => ({
    extraWhere: `AND COALESCE(v.published_at, v.created_at) > NOW() - make_interval(hours => ${bind(Math.trunc(ctx.cfg.rank_fresh_window_h))}::int)`,
    orderBy: "COALESCE(v.published_at, v.created_at) DESC, v.id DESC",
    limit: ctx.cfg.rank_cand_fresh,
  }));
}
