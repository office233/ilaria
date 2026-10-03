/**
 * Parametrii GET /api/explore/feed (zod; un parametru invalid e ignorat, nu 400).
 *   source=foryou|following · cursor · limit (1..50) · category|taxonomy_node_slug
 *   creator_id · v (clip fixat primul, doar prima pagină) · session_id (legacy)
 *   include_soft_commerce=1 · page (legacy; ignorat — paginarea e pe cursor)
 */
import { z } from "zod";

export const FEED_DEFAULT_LIMIT = 20;
export const FEED_MAX_LIMIT = 50;

const uuid = z.string().trim().uuid();

const Schema = z.object({
  source: z.enum(["foryou", "following"]).catch("foryou").default("foryou"),
  cursor: z.string().max(600).optional().catch(undefined),
  limit: z.coerce.number().int().min(1).max(FEED_MAX_LIMIT).catch(FEED_DEFAULT_LIMIT).default(FEED_DEFAULT_LIMIT),
  category: z.string().trim().regex(/^[a-z0-9][a-z0-9/_-]{0,120}$/i).optional().catch(undefined),
  creatorId: uuid.optional().catch(undefined),
  pinnedVideoId: uuid.optional().catch(undefined),
  sessionId: z.string().regex(/^[A-Za-z0-9._:-]{8,80}$/).optional().catch(undefined),
  includeSoftCommerce: z.boolean().default(false),
});

export type FeedRequest = z.infer<typeof Schema>;

export function parseFeedRequest(sp: URLSearchParams): FeedRequest {
  const get = (k: string) => {
    const v = sp.get(k);
    return v == null || v === "" ? undefined : v;
  };
  return Schema.parse({
    source: get("source"),
    cursor: get("cursor"),
    limit: get("limit"),
    category: get("category") ?? get("taxonomy_node_slug"),
    creatorId: get("creator_id"),
    pinnedVideoId: get("v"),
    sessionId: get("session_id"),
    includeSoftCommerce: sp.get("include_soft_commerce") === "1",
  });
}
