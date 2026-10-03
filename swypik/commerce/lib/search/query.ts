import { dbQuery } from "@/lib/db";

export type VideoResult = {
  id: string;
  title: string | null;
  thumbnail_url: string | null;
  playback_url: string | null;
  creator_id: string | null;
  creator_name: string | null;
  like_count: number;
  view_count: number;
  rank: number;
};

export type CreatorResult = {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  follower_count: number;
};

export type ProductResult = {
  id: string;
  title: string | null;
  price_cents: number | null;
  image_url: string | null;
  rank: number;
};


export type HashtagResult = {
  tag: string;
  video_count: number;
};

export type SearchOpts = {
  limit?: number;
  offset?: number;
  userId?: string | null;
};

const clampLimit = (n: number | undefined, max = 50, def = 20) => {
  const v = Number.isFinite(n) ? Number(n) : def;
  return Math.max(1, Math.min(max, v));
};

const clampOffset = (n: number | undefined) => {
  const v = Number.isFinite(n) ? Number(n) : 0;
  return Math.max(0, v);
};

/**
 * Full-text search over videos.search_document (tsvector).
 */
export async function searchVideos(
  q: string,
  opts: SearchOpts = {}
): Promise<VideoResult[]> {
  const limit = clampLimit(opts.limit);
  const offset = clampOffset(opts.offset);

  const sql = `
    WITH query AS (
      SELECT websearch_to_tsquery('simple', public.f_unaccent($1)) AS tsq,
             public.f_unaccent(lower($1)) AS qn
    )
    SELECT
      v.id::text                     AS id,
      v.title                        AS title,
      v.thumbnail_url                AS thumbnail_url,
      v.playback_url                 AS playback_url,
      v.creator_id::text             AS creator_id,
      COALESCE(u.display_name, u.username) AS creator_name,
      COALESCE(v.like_count, 0)::int       AS like_count,
      COALESCE(v.view_count, 0)::int       AS view_count,
      GREATEST(
        ts_rank_cd(v.search_document, query.tsq),
        similarity(public.f_unaccent(lower(coalesce(v.title, ''))), query.qn)
      )::float AS rank
    FROM videos v
    LEFT JOIN users u ON u.id = v.creator_id
    CROSS JOIN query
    WHERE v.status = 'ready'
      AND v.visibility = 'public'
      AND COALESCE(v.is_hidden, false) = false
      AND v.effective_label = 'safe'
      AND (
        v.search_document @@ query.tsq
        OR similarity(public.f_unaccent(lower(coalesce(v.title, ''))), query.qn) > 0.2
      )
    ORDER BY rank DESC, v.like_count DESC NULLS LAST, v.published_at DESC NULLS LAST
    LIMIT $2 OFFSET $3
  `;

  const { rows } = await dbQuery(sql, [q, limit, offset]);
  return rows as VideoResult[];
}

/**
 * Creator search via trigram similarity / ILIKE on username + display_name.
 * Uses pg_trgm similarity when available; falls back to ILIKE ordering.
 */
export async function searchCreators(
  q: string,
  opts: SearchOpts = {}
): Promise<CreatorResult[]> {
  const limit = clampLimit(opts.limit);
  const offset = clampOffset(opts.offset);

  const pattern = `%${q}%`;
  const prefix = `${q}%`;

  // Prefer trigram similarity if pg_trgm is installed; the operator `%`
  // requires the extension. We compute a similarity score and ORDER BY it.
  // creator_profiles is optional — LEFT JOIN with COALESCE.
  const sql = `
    SELECT
      u.id::text          AS id,
      u.username          AS username,
      u.display_name      AS display_name,
      u.avatar_url        AS avatar_url,
      u.bio               AS bio,
      COALESCE(f.followers, 0)::int AS follower_count
    FROM users u
    LEFT JOIN creator_profiles cp ON cp.user_id = u.id
    LEFT JOIN (SELECT following_user_id, COUNT(*) AS followers FROM follows GROUP BY 1) f ON f.following_user_id = u.id
    WHERE u.username       ILIKE $1
       OR u.display_name   ILIKE $1
    ORDER BY
      CASE
        WHEN u.username     ILIKE $2 THEN 0
        WHEN u.display_name ILIKE $2 THEN 1
        ELSE 2
      END,
      GREATEST(
        similarity(COALESCE(u.username, ''),     $3),
        similarity(COALESCE(u.display_name, ''), $3)
      ) DESC,
      COALESCE(f.followers, 0) DESC
    LIMIT $4 OFFSET $5
  `;

  try {
    const { rows } = await dbQuery(sql, [pattern, prefix, q, limit, offset]);
    return rows as CreatorResult[];
  } catch {
    // Fallback if creator_profiles table or similarity() is missing.
    const fallback = `
      SELECT
        u.id::text     AS id,
        u.username     AS username,
        u.display_name AS display_name,
        u.avatar_url   AS avatar_url,
        u.bio          AS bio,
        0::int         AS follower_count
      FROM users u
      WHERE u.username     ILIKE $1
         OR u.display_name ILIKE $1
      ORDER BY
        CASE
          WHEN u.username     ILIKE $2 THEN 0
          WHEN u.display_name ILIKE $2 THEN 1
          ELSE 2
        END,
        u.username ASC
      LIMIT $3 OFFSET $4
    `;
    const { rows } = await dbQuery(fallback, [pattern, prefix, limit, offset]);
    return rows as CreatorResult[];
  }
}

/**
 * Product search. Uses marketplace_products.search_document if present
 * (added by the 20260514 migration), else falls back to ILIKE on title.
 */
export async function searchProducts(
  q: string,
  opts: SearchOpts = {}
): Promise<ProductResult[]> {
  const limit = clampLimit(opts.limit);
  const offset = clampOffset(opts.offset);

  // Cross-language expansion: RO/DE/FR query → matching taxonomy slugs.
  // Product titles are predominantly EN; this lets "rochie" match slug fashion-women-dresses.
  let matchedSlugs: string[] = [];
  try {
    const { rows: slugRows } = await dbQuery<{ node_slug: string }>(
      `WITH q AS (SELECT public.f_unaccent(lower($1)) AS qn)
       SELECT DISTINCT node_slug
         FROM taxonomy_translations, q
        WHERE locale IN ('ro','de','fr','en')
          AND char_length(qn) >= 3
          AND (
            public.f_unaccent(lower(label)) LIKE qn || '%'
            OR qn LIKE public.f_unaccent(lower(label)) || '%'
            OR public.f_unaccent(lower(label)) LIKE '%' || qn || '%'
            OR word_similarity(qn, public.f_unaccent(lower(label))) > 0.65
            OR public.f_unaccent(lower(COALESCE(description,''))) LIKE '%' || qn || '%'
          )
        LIMIT 50`,
      [q]
    );
    matchedSlugs = slugRows.map((r) => r.node_slug);
  } catch {}

  const ftsSql = `
    WITH query AS (
      SELECT websearch_to_tsquery('simple', public.f_unaccent($1)) AS tsq,
             public.f_unaccent(lower($1)) AS qn
    )
    SELECT
      mp.id::text     AS id,
      mp.title        AS title,
      mp.price_cents  AS price_cents,
      mp.image_url    AS image_url,
      GREATEST(
        ts_rank_cd(mp.search_document, query.tsq),
        similarity(public.f_unaccent(lower(coalesce(mp.title, ''))), query.qn),
        CASE WHEN mp.taxonomy_node_slug = ANY($4::text[]) THEN 0.5 ELSE 0 END
      )::float AS rank
    FROM marketplace_products mp
    CROSS JOIN query
    WHERE mp.status = 'active'
      AND COALESCE(mp.is_adult, false) = false AND mp.effective_label = 'safe'
      AND (
        mp.search_document @@ query.tsq
        OR similarity(public.f_unaccent(lower(coalesce(mp.title, ''))), query.qn) > 0.2
        OR ($4::text[] <> ARRAY[]::text[] AND mp.taxonomy_node_slug = ANY($4::text[]))
      )
    ORDER BY rank DESC
    LIMIT $2 OFFSET $3
  `;

  try {
    const { rows } = await dbQuery(ftsSql, [q, limit, offset, matchedSlugs]);
    return rows as ProductResult[];
  } catch {
    const pattern = `%${q}%`;
    const ilikeSql = `
      SELECT
        mp.id::text     AS id,
        mp.title        AS title,
        mp.price_cents  AS price_cents,
        mp.image_url    AS image_url,
        0::float        AS rank
      FROM marketplace_products mp
      WHERE mp.status = 'active'
        AND COALESCE(mp.is_adult, false) = false AND mp.effective_label = 'safe'
        AND mp.title ILIKE $1
      ORDER BY mp.title ASC
      LIMIT $2 OFFSET $3
    `;
    const { rows } = await dbQuery(ilikeSql, [pattern, limit, offset]);
    return rows as ProductResult[];
  }
}



/**
 * Hashtag search: aggregates over videos.tags array. Strips leading '#' and matches case-insensitive prefix.
 */
export async function searchHashtags(
  q: string,
  opts: SearchOpts = {}
): Promise<HashtagResult[]> {
  const limit = clampLimit(opts.limit);
  const offset = clampOffset(opts.offset);
  const cleaned = q.replace(/^#+/, "").trim();
  if (!cleaned) return [];
  const pattern = cleaned + "%";
  const pattern2 = "%" + cleaned + "%";

  const sql = `
    SELECT
      lower(tag)            AS tag,
      COUNT(*)::int         AS video_count
    FROM videos v, unnest(v.tags) AS tag
    WHERE v.status = 'ready'
      AND v.visibility = 'public'
      AND COALESCE(v.is_hidden, false) = false
      AND v.effective_label = 'safe'
      AND (lower(tag) ILIKE $1 OR lower(tag) ILIKE $2)
    GROUP BY lower(tag)
    ORDER BY
      CASE WHEN lower(tag) ILIKE $1 THEN 0 ELSE 1 END,
      video_count DESC,
      lower(tag) ASC
    LIMIT $3 OFFSET $4
  `;
  try {
    const { rows } = await dbQuery(sql, [pattern, pattern2, limit, offset]);
    return rows as HashtagResult[];
  } catch {
    return [];
  }
}

export async function searchAll(
  q: string,
  opts: SearchOpts = {}
): Promise<{
  videos: VideoResult[];
  creators: CreatorResult[];
  products: ProductResult[];
  hashtags: HashtagResult[];
}> {
  const fanOpts: SearchOpts = { limit: 10, offset: 0, userId: opts.userId };
  const [videos, creators, products, hashtags] = await Promise.all([
    searchVideos(q, fanOpts).catch(() => [] as VideoResult[]),
    searchCreators(q, fanOpts).catch(() => [] as CreatorResult[]),
    searchProducts(q, fanOpts).catch(() => [] as ProductResult[]),
    searchHashtags(q, fanOpts).catch(() => [] as HashtagResult[]),
  ]);
  return { videos, creators, products, hashtags };
}
