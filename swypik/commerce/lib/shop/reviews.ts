/**
 * Recenziile produselor — o singură sursă pentru API și pagina de produs.
 * Doar cumpărătorii verificați (comandă plătită care conține produsul) pot
 * scrie; agregatul și lista exclud recenziile ascunse de moderare.
 */
import { dbQuery } from "@/lib/db";
import type { ReviewSort } from "./schemas";

/** Statusurile care dovedesc cumpărarea (plătită sau mai departe, nu rambursată). */
export const VERIFIED_ORDER_STATUSES = ["paid", "fulfilled", "delivered"] as const;

export type ReviewSummary = {
  average: number | null;
  total: number;
  /** distribution[0] = câte recenzii de 1 stea … distribution[4] = 5 stele. */
  distribution: [number, number, number, number, number];
};

export type ReviewItem = {
  id: string;
  rating: number;
  title: string | null;
  body: string | null;
  isVerifiedPurchase: boolean;
  helpfulCount: number;
  createdAt: string;
  author: string | null;
};

export type ReviewEligibility = { canReview: boolean; alreadyReviewed: boolean; orderId: string | null };

export async function getReviewSummary(productId: string): Promise<ReviewSummary> {
  const { rows } = await dbQuery<{ rating: number; n: number }>(
    `SELECT rating, COUNT(*)::int AS n
       FROM product_reviews
      WHERE product_id = $1 AND is_hidden = false
      GROUP BY rating`,
    [productId],
  );
  const distribution: ReviewSummary["distribution"] = [0, 0, 0, 0, 0];
  let total = 0;
  let sum = 0;
  for (const r of rows) {
    const rating = Number(r.rating);
    const n = Number(r.n) || 0;
    if (rating < 1 || rating > 5) continue;
    distribution[rating - 1] += n;
    total += n;
    sum += rating * n;
  }
  return { average: total > 0 ? Math.round((sum / total) * 10) / 10 : null, total, distribution };
}

const ORDER_BY: Record<ReviewSort, string> = {
  recent: "r.created_at DESC, r.id DESC",
  helpful: "r.helpful_count DESC, r.created_at DESC, r.id DESC",
  rating_high: "r.rating DESC, r.created_at DESC, r.id DESC",
  rating_low: "r.rating ASC, r.created_at DESC, r.id DESC",
};

export async function listReviews(
  productId: string,
  opts: { sort: ReviewSort; limit: number; offset: number },
): Promise<{ items: ReviewItem[]; hasMore: boolean }> {
  const { rows } = await dbQuery<{
    id: string;
    rating: number;
    title: string | null;
    body: string | null;
    is_verified_purchase: boolean;
    helpful_count: number;
    created_at: string;
    author: string | null;
  }>(
    `SELECT r.id::text AS id, r.rating, r.title, r.body, r.is_verified_purchase, r.helpful_count,
            r.created_at, COALESCE(NULLIF(u.display_name, ''), u.username) AS author
       FROM product_reviews r
       JOIN users u ON u.id = r.user_id
      WHERE r.product_id = $1 AND r.is_hidden = false
      ORDER BY ${ORDER_BY[opts.sort]}
      LIMIT $2 OFFSET $3`,
    [productId, opts.limit + 1, opts.offset],
  );
  const hasMore = rows.length > opts.limit;
  return {
    hasMore,
    items: rows.slice(0, opts.limit).map((r) => ({
      id: r.id,
      rating: Number(r.rating),
      title: r.title,
      body: r.body,
      isVerifiedPurchase: Boolean(r.is_verified_purchase),
      helpfulCount: Number(r.helpful_count) || 0,
      createdAt: new Date(r.created_at).toISOString(),
      author: r.author,
    })),
  };
}

export async function getReviewEligibility(productId: string, userId: string | null): Promise<ReviewEligibility> {
  if (!userId) return { canReview: false, alreadyReviewed: false, orderId: null };
  const { rows } = await dbQuery<{ reviewed: boolean; order_id: string | null }>(
    `SELECT EXISTS (SELECT 1 FROM product_reviews WHERE product_id = $1 AND user_id = $2) AS reviewed,
            (SELECT oi.order_id::text
               FROM commerce_order_items oi
               JOIN commerce_orders o ON o.id = oi.order_id
              WHERE oi.product_id = $1 AND o.buyer_user_id = $2
                AND o.status = ANY($3::text[])
              ORDER BY o.created_at DESC
              LIMIT 1) AS order_id`,
    [productId, userId, [...VERIFIED_ORDER_STATUSES]],
  );
  const row = rows[0];
  const alreadyReviewed = Boolean(row?.reviewed);
  const orderId = row?.order_id ?? null;
  return { canReview: Boolean(orderId) && !alreadyReviewed, alreadyReviewed, orderId };
}

export async function createReview(input: {
  productId: string;
  userId: string;
  orderId: string;
  rating: number;
  title: string | null;
  body: string | null;
}): Promise<string> {
  const { rows } = await dbQuery<{ id: string }>(
    `INSERT INTO product_reviews (product_id, user_id, order_id, rating, title, body, is_verified_purchase)
     VALUES ($1, $2, $3, $4, $5, $6, true)
     RETURNING id::text AS id`,
    [input.productId, input.userId, input.orderId, input.rating, input.title, input.body],
  );
  return rows[0].id;
}
