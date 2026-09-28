import { withErrorHandling } from "@/lib/api-handler";
/**
 * Admin: list orders with fraud risk scoring.
 *
 *   GET /api/admin/orders/risk?status=paid|pending&minScore=30
 *
 * Returns recent orders (90d) enriched with risk score + breakdown.
 * Aggregates buyer signals: account age, verified email/phone, prior orders, prior disputes.
 */
import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { requireAdmin } from "@/lib/admin/guard";
import { scoreOrderRisk } from "@/lib/risk/order-fraud-score";

export const dynamic = "force-dynamic";

type OrderRow = {
  id: string;
  status: string;
  buyer_user_id: string | null;
  currency: string;
  total_cents: number;
  created_at: string;
  metadata: Record<string, unknown> | null;
  buyer_email: string | null;
  buyer_phone: string | null;
  buyer_email_verified_at: string | null;
  buyer_phone_verified_at: string | null;
  buyer_created_at: string | null;
  prior_paid: number;
  prior_disputes: number;
  prior_chargebacks_lost: number;
};

interface RiskAddress {
  line1?: string | null;
  address_line_1?: string | null;
  country?: string | null;
}

interface OrderRiskMetadata {
  shipping_address?: RiskAddress;
  billing_address?: RiskAddress;
  items?: unknown[];
  item_count?: number | string;
  checkout_ip_country?: string | null;
  [key: string]: unknown;
}

async function GET_impl(req: Request) {
  const actor = await requireAdmin(req, "commerce");
  if (actor instanceof NextResponse) return actor;

  const url = new URL(req.url);
  const statusFilter = url.searchParams.get("status"); // "paid" | "pending" | null=all
  const minScore = Number(url.searchParams.get("minScore") ?? "0");

  const conditions: string[] = ["co.created_at > now() - interval '90 days'"];
  const args: string[] = [];
  if (statusFilter) {
    args.push(statusFilter);
    conditions.push(`co.status = $${args.length}`);
  }

  const { rows } = await dbQuery<OrderRow>(
    `SELECT co.id::text, co.status, co.buyer_user_id::text,
            co.currency, co.total_cents, co.created_at::text, co.metadata,
            u.email AS buyer_email,
            u.phone AS buyer_phone,
            u.email_verified_at::text AS buyer_email_verified_at,
            u.phone_verified_at::text AS buyer_phone_verified_at,
            u.created_at::text AS buyer_created_at,
            (SELECT COUNT(*)::int FROM commerce_orders co2
              WHERE co2.buyer_user_id = co.buyer_user_id
                AND co2.status IN ('paid','fulfilled','delivered')
                AND co2.id <> co.id) AS prior_paid,
            (SELECT COUNT(*)::int FROM stripe_disputes d
              JOIN commerce_orders co3 ON co3.id = d.order_id
              WHERE co3.buyer_user_id = co.buyer_user_id) AS prior_disputes,
            (SELECT COUNT(*)::int FROM stripe_disputes d
              JOIN commerce_orders co3 ON co3.id = d.order_id
              WHERE co3.buyer_user_id = co.buyer_user_id
                AND d.status IN ('lost','dispute_lost')) AS prior_chargebacks_lost
       FROM commerce_orders co
       LEFT JOIN users u ON u.id = co.buyer_user_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY co.created_at DESC
      LIMIT 500`,
    args,
  );

  const enriched = rows.map((o) => {
    const md = (o.metadata || {}) as OrderRiskMetadata;
    const ship = md.shipping_address || {};
    const bill = md.billing_address || {};
    const items = Array.isArray(md.items) ? md.items : [];
    const itemCount = Number(md.item_count) || items.length || 1;

    const accountAgeDays = o.buyer_created_at
      ? Math.floor(
          (Date.now() - new Date(o.buyer_created_at).getTime()) / (1000 * 60 * 60 * 24),
        )
      : null;

    const risk = scoreOrderRisk({
      totalCents: o.total_cents,
      currency: o.currency,
      itemCount,
      hasShippingAddress: Boolean(ship.line1 || ship.address_line_1),
      shippingCountry: ship.country || null,
      billingCountry: bill.country || null,
      ipCountry: md.checkout_ip_country || null,
      email: o.buyer_email,
      phone: o.buyer_phone,
      buyerAccountAgeDays: o.buyer_user_id ? accountAgeDays : null,
      emailVerified: Boolean(o.buyer_email_verified_at),
      phoneVerified: Boolean(o.buyer_phone_verified_at),
      priorPaidOrders: o.prior_paid,
      priorDisputes: o.prior_disputes,
      priorChargebacksLost: o.prior_chargebacks_lost,
    });

    return {
      id: o.id,
      status: o.status,
      total_cents: o.total_cents,
      currency: o.currency,
      created_at: o.created_at,
      buyer_email: o.buyer_email,
      buyer_user_id: o.buyer_user_id,
      shipping_country: ship.country || null,
      item_count: itemCount,
      prior_paid: o.prior_paid,
      prior_disputes: o.prior_disputes,
      risk,
    };
  });

  const filtered = minScore > 0 ? enriched.filter((o) => o.risk.score >= minScore) : enriched;

  filtered.sort((a, b) => b.risk.score - a.risk.score);

  const summary = {
    total: filtered.length,
    critical: filtered.filter((o) => o.risk.level === "critical").length,
    high: filtered.filter((o) => o.risk.level === "high").length,
    medium: filtered.filter((o) => o.risk.level === "medium").length,
    low: filtered.filter((o) => o.risk.level === "low").length,
  };

  return NextResponse.json({ success: true, summary, orders: filtered });
}

export const GET = withErrorHandling(GET_impl);
