/**
 * Sursa „backfill”: catalogul vizibil în ordine cronologică — garantează un feed
 * plin când sursele personalizate/recente sunt goale (catalog mic, cold start).
 */
import { runCandidateQuery, type CandidateContext, type CandidateHit } from "./common";

export function backfillCandidates(ctx: CandidateContext): Promise<CandidateHit[]> {
  return runCandidateQuery(ctx, "backfill", () => ({
    orderBy: "COALESCE(v.published_at, v.created_at) DESC, v.id DESC",
    limit: ctx.cfg.rank_cand_backfill,
  }));
}
