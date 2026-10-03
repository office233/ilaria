import AdsClient, { type Campaign, type ProductOption } from "./AdsClient";
import { dbQuery } from "@/lib/db";
import { requireSellerPage } from "@/lib/seller/page-auth";
import { sellerCurrency } from "@/lib/seller/config";
import {
  AD_DAILY_BUDGET_DEFAULT_RON,
  AD_DAILY_BUDGET_MAX_RON,
  AD_DAILY_BUDGET_MIN_RON,
  AD_TARGET_CITIES,
  AD_TYPES,
} from "@/lib/seller/ads-config";

export const dynamic = "force-dynamic";

export default async function SellerAdsPage() {
  const sellerId = await requireSellerPage("/seller/ads");

  const [{ rows: campaigns }, { rows: products }] = await Promise.all([
    dbQuery<Campaign>(
      `SELECT a.id, a.campaign_name, a.ad_type, a.product_id, p.title AS product_title,
              a.daily_budget_cents, a.spent_budget_cents, a.target_city, a.status,
              a.impressions_count, a.clicks_count, a.orders_count, a.revenue_cents, a.created_at
         FROM seller_ads a
         LEFT JOIN marketplace_products p ON a.product_id = p.id AND p.seller_id = a.seller_id
        WHERE a.seller_id = $1
        ORDER BY a.created_at DESC`,
      [sellerId],
    ),
    dbQuery<ProductOption>(
      `SELECT id, title, price_cents
         FROM marketplace_products
        WHERE seller_id = $1 AND status != 'archived'
        ORDER BY title ASC
        LIMIT 50`,
      [sellerId],
    ),
  ]);

  return (
    <AdsClient
      initialCampaigns={campaigns}
      sellerProducts={products}
      currency={sellerCurrency()}
      adTypes={AD_TYPES}
      budget={{ min: AD_DAILY_BUDGET_MIN_RON, max: AD_DAILY_BUDGET_MAX_RON, default: AD_DAILY_BUDGET_DEFAULT_RON }}
      targetCities={AD_TARGET_CITIES}
    />
  );
}
