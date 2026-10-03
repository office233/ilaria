/**
 * Cifrele reale ale dashboard-ului de seller: vânzări 30 de zile (vs. 30 anterioare),
 * comenzi de procesat, produse active / fără stoc, sold, ultimele comenzi, onboarding.
 */
import { dbQuery } from "@/lib/db";
import { countSellerOrdersByTab, listSellerOrders } from "./orders";
import { getSellerBalance } from "./payouts";
import { getSellerOnboarding } from "./onboarding";
import { sellerCurrency } from "./config";
import { getImportedSalesStats } from "./imports/analytics";

const PAID_STATUSES = ["paid", "fulfilled", "delivered", "partially_refunded"];

export async function getSellerSalesStats(sellerId: string) {
  const { rows } = await dbQuery<Record<string, string | number>>(
    `SELECT
       COALESCE(SUM(coi.quantity * coi.unit_amount_cents) FILTER (WHERE co.created_at >= now() - interval '30 days'), 0)::bigint AS sales_30,
       COALESCE(SUM(coi.quantity * coi.unit_amount_cents) FILTER (
         WHERE co.created_at < now() - interval '30 days' AND co.created_at >= now() - interval '60 days'), 0)::bigint AS sales_prev_30,
       COUNT(DISTINCT co.id) FILTER (WHERE co.created_at >= now() - interval '30 days')::int AS orders_30,
       COALESCE(SUM(NULLIF(coi.metadata->>'seller_payout_cents', '')::int) FILTER (
         WHERE co.created_at >= now() - interval '30 days'), 0)::bigint AS net_30
     FROM commerce_order_items coi
     JOIN commerce_orders co ON co.id = coi.order_id
    WHERE coi.metadata->>'seller_id' = $1
      AND coi.source_status <> 'cancelled'
      AND co.status = ANY($2::text[])
      AND co.created_at >= now() - interval '60 days'`,
    [sellerId, PAID_STATUSES],
  );
  const r = rows[0] ?? {};
  return {
    sales30Cents: Number(r.sales_30 ?? 0),
    salesPrev30Cents: Number(r.sales_prev_30 ?? 0),
    orders30: Number(r.orders_30 ?? 0),
    net30Cents: Number(r.net_30 ?? 0),
  };
}

export async function getSellerProductStats(sellerId: string) {
  const { rows } = await dbQuery<{ active: number; out_of_stock: number; draft: number }>(
    `SELECT COUNT(*) FILTER (WHERE status = 'active' AND inventory_status <> 'out_of_stock')::int AS active,
            COUNT(*) FILTER (WHERE status <> 'archived' AND inventory_status = 'out_of_stock')::int AS out_of_stock,
            COUNT(*) FILTER (WHERE status = 'draft')::int AS draft
       FROM marketplace_products WHERE seller_id = $1`,
    [sellerId],
  );
  const r = rows[0];
  return { active: Number(r?.active ?? 0), outOfStock: Number(r?.out_of_stock ?? 0), draft: Number(r?.draft ?? 0) };
}

export async function getSellerIntegrationStats(sellerId: string) {
  const { rows } = await dbQuery<{
    connected: number;
    auto_active: number;
    auto_pending: number;
    auto_degraded: number;
    auto_unavailable: number;
  }>(
    `SELECT COUNT(*)::int AS connected,
            COUNT(*) FILTER (WHERE webhook_status = 'active')::int AS auto_active,
            COUNT(*) FILTER (WHERE webhook_status = 'pending')::int AS auto_pending,
            COUNT(*) FILTER (WHERE webhook_status = 'degraded')::int AS auto_degraded,
            COUNT(*) FILTER (WHERE webhook_status = 'unavailable')::int AS auto_unavailable
       FROM seller_catalog_integrations
      WHERE seller_id = $1 AND status = 'active'`,
    [sellerId],
  );
  const row = rows[0];
  const connected = Number(row?.connected ?? 0);
  const active = Number(row?.auto_active ?? 0);
  const pending = Number(row?.auto_pending ?? 0);
  const degraded = Number(row?.auto_degraded ?? 0);
  const unavailable = Number(row?.auto_unavailable ?? 0);
  const autoSyncStatus =
    connected === 0
      ? null
      : unavailable > 0
        ? ("unavailable" as const)
        : degraded > 0
          ? ("degraded" as const)
          : pending > 0 || active < connected
            ? ("pending" as const)
            : ("active" as const);
  return { connected, active, pending, degraded, unavailable, autoSyncStatus };
}

export async function getSellerDashboard(sellerId: string) {
  const [sales, products, counts, balance, recent, onboarding, importedSales, integrations] = await Promise.all([
    getSellerSalesStats(sellerId),
    getSellerProductStats(sellerId),
    countSellerOrdersByTab(sellerId),
    getSellerBalance(sellerId),
    listSellerOrders(sellerId, { tab: "all", limit: 5, offset: 0, q: null }),
    getSellerOnboarding(sellerId),
    getImportedSalesStats(sellerId),
    getSellerIntegrationStats(sellerId),
  ]);
  return {
    currency: sellerCurrency(),
    sales,
    products,
    orders: { todo: counts.todo, shipped: counts.shipped, issues: counts.issues },
    balance,
    recentOrders: recent.orders,
    onboarding,
    importedSales,
    integrations,
  };
}
export type SellerDashboardData = Awaited<ReturnType<typeof getSellerDashboard>>;
