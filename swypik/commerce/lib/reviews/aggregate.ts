/**
 * Aggregate product ratings from product_reviews.
 *
 * Returns one entry per product id requested. Excludes hidden reviews.
 * Safe with empty input. Single round-trip query, no N+1.
 */

import { dbQuery } from "@/lib/db";

export type ProductRatingAggregate = {
  productId: string;
  avgRating: number;
  reviewCount: number;
};

export async function getProductRatingAggregate(
  productIds: string[]
): Promise<ProductRatingAggregate[]> {
  const ids = Array.from(
    new Set(productIds.filter((id): id is string => typeof id === "string" && id.length > 0))
  );
  if (ids.length === 0) return [];

  try {
    const { rows } = await dbQuery<{
      product_id: string;
      avg_rating: string | number | null;
      review_count: string | number | null;
    }>(
      `SELECT product_id::text AS product_id,
              AVG(rating)::numeric(3,2) AS avg_rating,
              COUNT(*)::int AS review_count
         FROM product_reviews
        WHERE is_hidden = false
          AND product_id::text = ANY($1::text[])
        GROUP BY product_id`,
      [ids]
    );

    return rows.map((r) => ({
      productId: r.product_id,
      avgRating: Number(r.avg_rating ?? 0),
      reviewCount: Number(r.review_count ?? 0),
    }));
  } catch {
    // Table may not exist yet (e.g. pre-migration env). Return empty quietly.
    return [];
  }
}

export async function getProductRatingMap(
  productIds: string[]
): Promise<Map<string, ProductRatingAggregate>> {
  const list = await getProductRatingAggregate(productIds);
  return new Map(list.map((r) => [r.productId, r]));
}
