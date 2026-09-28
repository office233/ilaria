/** Sursa „following”: clipurile recente ale creatorilor urmăriți. */
import { runCandidateQuery, type CandidateContext, type CandidateHit } from "./common";

export function followingCandidates(ctx: CandidateContext, limit = ctx.cfg.rank_cand_following): Promise<CandidateHit[]> {
  if (ctx.followedCreatorIds.length === 0) return Promise.resolve([]);
  return runCandidateQuery(ctx, "following", (bind) => ({
    extraWhere: `AND v.creator_id = ANY(${bind(ctx.followedCreatorIds)}::uuid[])
      AND COALESCE(v.published_at, v.created_at) > NOW() - make_interval(days => ${bind(Math.trunc(ctx.cfg.rank_following_window_d))}::int)`,
    orderBy: "COALESCE(v.published_at, v.created_at) DESC, v.id DESC",
    limit,
  }));
}
