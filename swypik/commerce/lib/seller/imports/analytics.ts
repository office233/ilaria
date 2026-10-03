import { dbQuery } from "@/lib/db";

export type ImportedSalesStat = {
  currency: string;
  sales30Cents: number;
  salesPrev30Cents: number;
  orders30: number;
  lifetimeSalesCents: number;
  lifetimeOrders: number;
  refundedLifetimeCents: number;
};

const REVENUE_STATUSES = ["paid", "fulfilled", "partially_refunded"];

export async function getImportedSalesStats(sellerId: string): Promise<ImportedSalesStat[]> {
  const { rows } = await dbQuery<{
    currency: string;
    sales_30: string | number;
    sales_prev_30: string | number;
    orders_30: string | number;
    lifetime_sales: string | number;
    lifetime_orders: string | number;
    refunded_lifetime: string | number;
  }>(
    `SELECT currency,
            COALESCE(SUM(total_cents) FILTER (
              WHERE normalized_status = ANY($2::text[])
                AND placed_at >= now() - interval '30 days'
            ), 0)::bigint AS sales_30,
            COALESCE(SUM(total_cents) FILTER (
              WHERE normalized_status = ANY($2::text[])
                AND placed_at < now() - interval '30 days'
                AND placed_at >= now() - interval '60 days'
            ), 0)::bigint AS sales_prev_30,
            COUNT(*) FILTER (
              WHERE normalized_status = ANY($2::text[])
                AND placed_at >= now() - interval '30 days'
            )::int AS orders_30,
            COALESCE(SUM(total_cents) FILTER (
              WHERE normalized_status = ANY($2::text[])
            ), 0)::bigint AS lifetime_sales,
            COUNT(*) FILTER (
              WHERE normalized_status = ANY($2::text[])
            )::int AS lifetime_orders,
            COALESCE(SUM(refunded_cents), 0)::bigint AS refunded_lifetime
       FROM seller_imported_orders
      WHERE seller_id = $1
      GROUP BY currency
      ORDER BY currency`,
    [sellerId, REVENUE_STATUSES],
  );

  return rows.map((row) => ({
    currency: row.currency,
    sales30Cents: Number(row.sales_30 ?? 0),
    salesPrev30Cents: Number(row.sales_prev_30 ?? 0),
    orders30: Number(row.orders_30 ?? 0),
    lifetimeSalesCents: Number(row.lifetime_sales ?? 0),
    lifetimeOrders: Number(row.lifetime_orders ?? 0),
    refundedLifetimeCents: Number(row.refunded_lifetime ?? 0),
  }));
}
