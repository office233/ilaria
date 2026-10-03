import { NextResponse } from "next/server";
import { z } from "zod";
import { dbQuery } from "@/lib/db";
import { getSellerSessionId } from "@/lib/security/seller-auth";
import { rateLimit } from "@/lib/security/rate-limit";
import { parseBody } from "@/lib/validation/schemas";
import { withErrorHandling } from "@/lib/api-handler";
import {
  AD_DAILY_BUDGET_DEFAULT_RON,
  AD_DAILY_BUDGET_MAX_RON,
  AD_DAILY_BUDGET_MIN_RON,
  AD_TARGET_ALL_RO,
  AD_TARGET_CITIES,
  AD_TYPES,
} from "@/lib/seller/ads-config";

export const dynamic = "force-dynamic";

const CreateAdSchema = z.object({
  campaignName: z.string().trim().min(1).max(120),
  adType: z.enum(AD_TYPES).default("boost_reel"),
  productId: z.string().uuid().optional(),
  dailyBudgetRon: z.coerce.number().min(AD_DAILY_BUDGET_MIN_RON).max(AD_DAILY_BUDGET_MAX_RON).default(AD_DAILY_BUDGET_DEFAULT_RON),
  targetCity: z.enum(AD_TARGET_CITIES).default(AD_TARGET_ALL_RO),
});

type CampaignRow = {
  spent_budget_cents: string | number;
  revenue_cents: string | number;
  impressions_count: string | number;
  clicks_count: string | number;
  orders_count: string | number;
};

export const GET = withErrorHandling(async function GET() {
  const sellerId = await getSellerSessionId();
  if (!sellerId) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }

  const { rows: campaigns } = await dbQuery<CampaignRow>(
    `SELECT a.id, a.campaign_name, a.ad_type, a.product_id, p.title AS product_title,
            a.daily_budget_cents, a.spent_budget_cents, a.target_city, a.status,
            a.impressions_count, a.clicks_count, a.orders_count, a.revenue_cents, a.created_at
       FROM seller_ads a
       LEFT JOIN marketplace_products p ON p.id = a.product_id
      WHERE a.seller_id = $1
      ORDER BY a.created_at DESC`,
    [sellerId],
  );

  const summary = campaigns.reduce(
    (acc, c) => {
      acc.totalSpentCents += Number(c.spent_budget_cents) || 0;
      acc.totalRevenueCents += Number(c.revenue_cents) || 0;
      acc.totalImpressions += Number(c.impressions_count) || 0;
      acc.totalClicks += Number(c.clicks_count) || 0;
      acc.totalOrders += Number(c.orders_count) || 0;
      return acc;
    },
    { totalSpentCents: 0, totalRevenueCents: 0, totalImpressions: 0, totalClicks: 0, totalOrders: 0 },
  );
  const roas = summary.totalSpentCents > 0 ? (summary.totalRevenueCents / summary.totalSpentCents).toFixed(2) : "0.00";

  return NextResponse.json({ success: true, campaigns, summary: { ...summary, roas } });
});

export const POST = withErrorHandling(async function POST(req: Request) {
  const sellerId = await getSellerSessionId();
  if (!sellerId) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }
  const rl = await rateLimit("sellerAds", sellerId);
  if (!rl.success) {
    return NextResponse.json({ success: false, error: "rate_limited" }, { status: 429 });
  }

  const parsed = parseBody(CreateAdSchema, await req.json().catch(() => null));
  if (!parsed.ok) {
    return NextResponse.json({ success: false, error: "validation_error" }, { status: 400 });
  }
  const ad = parsed.data;

  // IDOR: produsul promovat trebuie să fie al acestui seller.
  if (ad.productId) {
    const { rows: owned } = await dbQuery(
      `SELECT 1 FROM marketplace_products WHERE id = $1 AND seller_id = $2 LIMIT 1`,
      [ad.productId, sellerId],
    );
    if (owned.length === 0) {
      return NextResponse.json({ success: false, error: "product_not_owned" }, { status: 403 });
    }
  }

  // Statusul initial e cel implicit din DB (pending_review): nu exista inca un
  // motor de livrare a reclamelor, deci nu pretindem ca a fost lansata.
  const { rows } = await dbQuery(
    `INSERT INTO seller_ads (seller_id, campaign_name, ad_type, product_id, daily_budget_cents, target_city)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, campaign_name, ad_type, daily_budget_cents, status, created_at`,
    [sellerId, ad.campaignName, ad.adType, ad.productId ?? null, Math.round(ad.dailyBudgetRon * 100), ad.targetCity],
  );

  return NextResponse.json({ success: true, campaign: rows[0] }, { status: 201 });
});
