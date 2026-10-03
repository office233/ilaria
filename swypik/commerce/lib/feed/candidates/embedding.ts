/**
 * SEAM pgvector (inactiv implicit — nu e o dependență a feed-ului).
 *
 * Retrieval semantic: vectorul „gustului” viewerului = media embeddings-urilor
 * clipurilor cu semnal pozitiv în ultimele 7 zile; candidații = cei mai
 * apropiați vecini `ORDER BY v.embedding <=> taste.vec`.
 *
 * Activare: `FEED_EMBEDDINGS=1` după ce:
 *   1. `videos.embedding` e populat (cron embed-batch / furnizorul ales de owner);
 *   2. există index HNSW: CREATE INDEX CONCURRENTLY ... USING hnsw (embedding vector_cosine_ops);
 *   3. (v1) `user_embeddings(user_id, vec, updated_at)` precalculat de cron —
 *      înlocuiește CTE-ul `taste` de mai jos fără alte schimbări.
 * Fără flag sau fără user → [] (celelalte surse acoperă feed-ul).
 */
import { runCandidateQuery, type CandidateContext, type CandidateHit } from "./common";

export const EMBEDDING_CANDIDATES_LIMIT = 150;

export function embeddingsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FEED_EMBEDDINGS === "1";
}

export function embeddingCandidates(ctx: CandidateContext): Promise<CandidateHit[]> {
  if (!ctx.userId || !embeddingsEnabled()) return Promise.resolve([]);
  return runCandidateQuery(ctx, "embedding", (_bind, userP) => ({
    with: `WITH taste AS MATERIALIZED (
        SELECT AVG(v_t.embedding) AS vec
          FROM feed_events fe_t JOIN videos v_t ON v_t.id = fe_t.video_id
         WHERE fe_t.actor_user_id = ${userP}::uuid
           AND fe_t.event_type IN ('like', 'save', 'share', 'completion')
           AND fe_t.occurred_at > NOW() - INTERVAL '7 days'
           AND v_t.embedding IS NOT NULL
      )`,
    from: "videos v CROSS JOIN taste",
    extraWhere: "AND taste.vec IS NOT NULL AND v.embedding IS NOT NULL",
    orderBy: "v.embedding <=> taste.vec ASC, v.id DESC",
    limit: EMBEDDING_CANDIDATES_LIMIT,
  }));
}
