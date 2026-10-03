/**
 * GET  /api/products/[id]/reviews?sort=recent|helpful|rating_high|rating_low&limit=&offset=
 *      → { items, hasMore, summary }
 * POST /api/products/[id]/reviews  { rating, title?, body? }
 *      → doar cumpărători verificați (comandă plătită care conține produsul).
 */
import { NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/session";
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/security/rate-limit";
import { parseBody } from "@/lib/validation/schemas";
import { UUID_RE } from "@/lib/validation/uuid";
import { REVIEWS_PAGE_SIZE } from "@/lib/shop/config";
import { REVIEW_SORTS, ShopReviewCreateSchema, type ReviewSort } from "@/lib/shop/schemas";
import { createReview, getReviewEligibility, getReviewSummary, listReviews } from "@/lib/shop/reviews";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

function parseSort(value: string | null): ReviewSort {
  return (REVIEW_SORTS as readonly string[]).includes(value ?? "") ? (value as ReviewSort) : "recent";
}

export async function GET(req: Request, { params }: Ctx) {
  try {
    const { id: productId } = await params;
    if (!UUID_RE.test(productId)) return NextResponse.json({ code: "invalid_product" }, { status: 400 });
    const url = new URL(req.url);
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || REVIEWS_PAGE_SIZE));
    const offset = Math.max(0, Math.floor(Number(url.searchParams.get("offset")) || 0));
    const sort = parseSort(url.searchParams.get("sort"));
    const [page, summary] = await Promise.all([
      listReviews(productId, { sort, limit, offset }),
      getReviewSummary(productId),
    ]);
    return NextResponse.json({ ...page, summary, offset, limit, sort });
  } catch (error: unknown) {
    logger.error({ err: error }, "[reviews] GET failed");
    return NextResponse.json({ code: "internal" }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: Ctx) {
  try {
    const session = await getAuthSession();
    if (!session) return NextResponse.json({ code: "auth_required" }, { status: 401 });

    const rl = await rateLimit("productReviews", session.userId);
    if (!rl.success) return NextResponse.json({ code: "rate_limited" }, { status: 429 });

    const { id: productId } = await params;
    if (!UUID_RE.test(productId)) return NextResponse.json({ code: "invalid_product" }, { status: 400 });

    const parsed = parseBody(ShopReviewCreateSchema, await req.json().catch(() => null));
    if (!parsed.ok) return NextResponse.json({ code: "validation_error" }, { status: 400 });

    const { rows } = await dbQuery<{ id: string }>(`SELECT id FROM marketplace_products WHERE id = $1 LIMIT 1`, [productId]);
    if (!rows[0]) return NextResponse.json({ code: "product_not_found" }, { status: 404 });

    const eligibility = await getReviewEligibility(productId, session.userId);
    if (eligibility.alreadyReviewed) return NextResponse.json({ code: "already_reviewed" }, { status: 409 });
    if (!eligibility.orderId) return NextResponse.json({ code: "not_verified_buyer" }, { status: 403 });

    try {
      const id = await createReview({
        productId,
        userId: session.userId,
        orderId: eligibility.orderId,
        rating: parsed.data.rating,
        title: parsed.data.title || null,
        body: parsed.data.body || null,
      });
      return NextResponse.json({ id, isVerifiedPurchase: true }, { status: 201 });
    } catch (err: unknown) {
      if ((err as { code?: string } | null)?.code === "23505") {
        return NextResponse.json({ code: "already_reviewed" }, { status: 409 });
      }
      throw err;
    }
  } catch (error: unknown) {
    logger.error({ err: error }, "[reviews] POST failed");
    return NextResponse.json({ code: "internal" }, { status: 500 });
  }
}
