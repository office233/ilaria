import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { embed, toPgVector, isEmbeddingConfigured } from "@/lib/ai/embeddings";
import { applyCachePolicy } from "@/lib/http/cache-policy";

export const dynamic = "force-dynamic";

type ProductRow = {
  id: string;
  title: string;
  price_cents: number | null;
  image_url: string | null;
  distance?: number | string | null;
  text_rank?: number | string | null;
  lexical_score?: number | string | null;
};

const HEADERS = {
  "Cache-Control": "no-store",
};

/** Rezultat reușit (inclusiv „fără rezultate”) → cache la edge; eroarea rămâne no-store. */
function cached(req: Request, body: unknown): NextResponse {
  return applyCachePolicy(NextResponse.json(body), "products/similar", req);
}

const VECTOR_MIN_SIMILARITY = 0.35;
const PRODUCT_VECTOR_MIN_SIMILARITY = 0.42;
const BASE_PRODUCT_WHERE = `
  status = 'active'
  AND COALESCE(is_adult, false) = false AND effective_label = 'safe'
  AND price_cents IS NOT NULL
  AND image_url IS NOT NULL
  AND taxonomy_node_slug IS NOT NULL
`;
const SOFT_COMMERCE_SQL_RE = [
  "sexy",
  "adult",
  "erotic",
  "fetish",
  "bdsm",
  "underwear",
  "underpants",
  "panties",
  "panty",
  "lingerie",
  "shapewear",
  "body[ -]?shaper",
  "bodysuit",
  "bras?",
  "bralette",
  "briefs",
  "menstrual panties",
  "girdle",
  "corset",
  "bikini",
  "swimwear",
  "nightdress",
  "sleepwear",
  "slip sleep",
].join("|");
const SOFT_COMMERCE_QUERY_RE = /\b(sexy|adult|erotic|fetish|bdsm|underwear|underpants|panties|panty|lingerie|shapewear|bodysuit|bra|bras|bralette|briefs|bikini|swimwear|nightdress|sleepwear|socks?)\b/i;

function escapeLike(input: string) {
  return input.toLowerCase().replace(/[\\%_]/g, "\\$&");
}

function taxonomyFamilySlug(slug: string | null) {
  if (!slug) return null;
  const parts = slug.split("-").filter(Boolean);
  if (parts[0] === "electronics" && parts[1] === "phones") return "electronics-phones";
  return parts.slice(0, Math.min(3, parts.length)).join("-") || null;
}

function toProduct(row: ProductRow, relevance: "text" | "vector") {
  const distance = row.distance == null ? null : Number(row.distance);
  const vectorSimilarity = distance == null ? null : Math.max(0, Math.min(1, 1 - distance));
  const textSimilarity = Math.min(
    0.99,
    Math.max(0.55, 0.55 + Number(row.lexical_score || 0) + Number(row.text_rank || 0))
  );

  return {
    id: row.id,
    title: row.title,
    price: (row.price_cents || 0) / 100,
    image: row.image_url,
    rating: null,
    ratingCount: 0,
    similarity: relevance === "vector" ? vectorSimilarity : textSimilarity,
    relevance,
  };
}

async function searchByText(text: string, limit: number) {
  const likeText = escapeLike(text);
  const slugText = escapeLike(text.replace(/\s+/g, "-"));
  const softCommerceClause = SOFT_COMMERCE_QUERY_RE.test(text)
    ? ""
    : `
          AND COALESCE(mp.title, '') !~* '${SOFT_COMMERCE_SQL_RE}'
          AND COALESCE(mp.taxonomy_node_slug, '') !~* '(underwear|lingerie|swimwear)'
            AND COALESCE(mp.category, '') !~* '${SOFT_COMMERCE_SQL_RE}'
      `;
  const res = await dbQuery<ProductRow>(
    `WITH q AS (
       SELECT websearch_to_tsquery('simple', $1) AS query,
              $2::text AS like_text,
              $3::text AS slug_text
     ), ranked AS (
       SELECT mp.id,
              mp.title,
              mp.price_cents,
              mp.image_url,
              ts_rank_cd(
                to_tsvector('simple', concat_ws(' ', mp.title, mp.taxonomy_node_slug, mp.category)),
                q.query
              ) AS text_rank,
              (
                CASE WHEN lower(mp.title) LIKE q.like_text || '%' ESCAPE '\\' THEN 0.45 ELSE 0 END +
                CASE WHEN lower(mp.title) LIKE '%' || q.like_text || '%' ESCAPE '\\' THEN 0.35 ELSE 0 END +
                CASE WHEN to_tsvector('simple', concat_ws(' ', mp.title, mp.taxonomy_node_slug, mp.category)) @@ q.query THEN 0.30 ELSE 0 END +
                CASE WHEN lower(COALESCE(mp.taxonomy_node_slug, '')) LIKE '%' || q.slug_text || '%' ESCAPE '\\' THEN 0.30 ELSE 0 END +
                CASE WHEN lower(COALESCE(mp.category, '')) LIKE '%' || q.like_text || '%' ESCAPE '\\' THEN 0.20 ELSE 0 END
              ) AS lexical_score
         FROM marketplace_products mp
         CROSS JOIN q
        WHERE ${BASE_PRODUCT_WHERE}
          ${softCommerceClause}
          AND (
            to_tsvector('simple', concat_ws(' ', mp.title, mp.taxonomy_node_slug, mp.category)) @@ q.query
            OR lower(mp.title) LIKE '%' || q.like_text || '%' ESCAPE '\\'
            OR lower(COALESCE(mp.taxonomy_node_slug, '')) LIKE '%' || q.slug_text || '%' ESCAPE '\\'
            OR lower(COALESCE(mp.category, '')) LIKE '%' || q.like_text || '%' ESCAPE '\\'
          )
     )
     SELECT *
       FROM ranked
      ORDER BY lexical_score DESC, text_rank DESC, id
      LIMIT $4`,
    [text, likeText, slugText, limit]
  );
  return res.rows.map((row) => toProduct(row, "text"));
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const productId = url.searchParams.get("product_id");
  const text = url.searchParams.get("text")?.trim() || null;
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "10", 10) || 10, 1), 50);

  if (!productId && !text) {
    return NextResponse.json({ error: "product_id or text required" }, { status: 400 });
  }

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (productId && !UUID_RE.test(productId)) {
    return NextResponse.json({ error: "invalid_product_id" }, { status: 400 });
  }
  if (text && (text.length < 2 || text.length > 200)) {
    return NextResponse.json({ error: "invalid_text" }, { status: 400 });
  }

  let pgVec: string | null = null;
  let excludeId: string | null = null;
  let sourceTaxonomySlug: string | null = null;

  try {
    if (productId) {
      excludeId = productId;
      const res = await dbQuery<{ embedding: string | null; taxonomy_node_slug: string | null }>(
        `SELECT embedding::text AS embedding, taxonomy_node_slug FROM marketplace_products WHERE id = $1 LIMIT 1`,
        [productId]
      );
      const row = res.rows[0];
      if (!row || !row.embedding) {
        // niciun embedding pt produs (pgvector neactivat sau cron încă nu a procesat)
        return cached(req, { products: [], reason: "no-embedding" });
      }
      pgVec = row.embedding;
      sourceTaxonomySlug = row.taxonomy_node_slug;
    } else if (text) {
      const textProducts = await searchByText(text, limit);
      if (textProducts.length > 0) {
        return cached(req, { products: textProducts, mode: "text" });
      }
      if (!isEmbeddingConfigured()) {
        return cached(req, { products: [], reason: "embeddings-off" });
      }
      const vec = await embed(text);
      pgVec = toPgVector(vec);
    }

    if (!pgVec) {
      return cached(req, { products: [] });
    }

    const minSimilarity = productId ? PRODUCT_VECTOR_MIN_SIMILARITY : VECTOR_MIN_SIMILARITY;
    const params: any[] = [pgVec, limit, minSimilarity];
    let where = `${BASE_PRODUCT_WHERE}
      AND embedding IS NOT NULL
      AND (1 - (embedding <=> $1::vector)) >= $3`;
    const hideSoftCommerce = text ? !SOFT_COMMERCE_QUERY_RE.test(text) : !/underwear|lingerie|swimwear/i.test(sourceTaxonomySlug || "");
    if (hideSoftCommerce) {
      where += `
        AND COALESCE(title, '') !~* '${SOFT_COMMERCE_SQL_RE}'
        AND COALESCE(taxonomy_node_slug, '') !~* '(underwear|lingerie|swimwear)'
        AND COALESCE(category, '') !~* '${SOFT_COMMERCE_SQL_RE}'`;
    }
    if (excludeId) {
      params.push(excludeId);
      where += ` AND id <> $${params.length}`;
    }
    let taxonomyOrder = "";
    if (sourceTaxonomySlug) {
      params.push(sourceTaxonomySlug);
      const sourceTaxonomyParam = `$${params.length}`;
      const sourceFamilySlug = taxonomyFamilySlug(sourceTaxonomySlug);
      if (sourceFamilySlug) {
        params.push(sourceFamilySlug);
        where += ` AND taxonomy_node_slug LIKE $${params.length} || '%'`;
      }
      taxonomyOrder = `CASE WHEN taxonomy_node_slug = ${sourceTaxonomyParam} THEN 0 ELSE 1 END, `;
    }

    const res = await dbQuery<ProductRow>(
      `SELECT id, title, price_cents, image_url,
              (embedding <=> $1::vector) AS distance
         FROM marketplace_products
        WHERE ${where}
        ORDER BY ${taxonomyOrder}embedding <=> $1::vector
        LIMIT $2`,
      params
    );

    const products = res.rows.map((row) => toProduct(row, "vector"));

    return cached(req, { products, mode: "vector", reason: products.length ? undefined : "low-similarity" });
  } catch (e: any) {
    // probabil pgvector neactivat sau coloana embedding lipsește
    return NextResponse.json(
      { products: [], reason: "unavailable", error: String(e?.message || e).slice(0, 200) },
      { headers: HEADERS, status: 200 }
    );
  }
}
