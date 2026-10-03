/**
 * Sursa „topic”: clipuri ale căror tag-uri se potrivesc cu interesele explicite
 * ale viewerului (`user_interests`: onboarding + more_like_this/not_interested),
 * prin sinonimele din lib/topics.ts. Singurul mecanism de cold start care
 * funcționează din primul clip, fără embeddings.
 */
import { TOPICS, topicSearchTerms } from "@/lib/topics";
import { runCandidateQuery, type CandidateContext, type CandidateHit } from "./common";

function synonymsJson(): string {
  return JSON.stringify(TOPICS.map((t) => ({ topic: t.id, terms: topicSearchTerms(t.id) })));
}

export function topicCandidates(ctx: CandidateContext): Promise<CandidateHit[]> {
  if (!ctx.userId) return Promise.resolve([]);
  return runCandidateQuery(ctx, "topic", (bind, userP) => {
    const syn = bind(synonymsJson());
    return {
      with: `WITH syn AS (
          SELECT t.topic, ARRAY(SELECT jsonb_array_elements_text(t.terms)) AS terms
            FROM jsonb_to_recordset(${syn}::jsonb) AS t(topic text, terms jsonb)
        ), ui AS (
          SELECT GREATEST(0, LEAST(1, ui.weight / 5.0))::float AS w, COALESCE(syn.terms, ARRAY[ui.topic]) AS terms
            FROM user_interests ui LEFT JOIN syn ON syn.topic = ui.topic
           WHERE ui.user_id = ${userP}::uuid AND ui.weight > 0
        )`,
      select: `LEAST(1, (SELECT COALESCE(SUM(ui.w), 0) FROM ui WHERE COALESCE(v.tags, ARRAY[]::text[]) && ui.terms)) AS affinity`,
      extraWhere: `AND EXISTS (SELECT 1 FROM ui WHERE COALESCE(v.tags, ARRAY[]::text[]) && ui.terms)`,
      orderBy: "affinity DESC, COALESCE(v.published_at, v.created_at) DESC, v.id DESC",
      limit: ctx.cfg.rank_cand_topic,
    };
  });
}
