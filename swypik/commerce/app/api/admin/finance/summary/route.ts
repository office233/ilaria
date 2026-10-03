/**
 * FRONT R5 — raport financiar minimal (admin).
 *
 * GET /api/admin/finance/summary?from=YYYY-MM-DD&to=YYYY-MM-DD
 *   (implicit: ultimele 30 de zile)
 *
 * Sursa de adevăr: wallet_ledger_entries.
 *   - commission_*  pe contul platformei → veniturile platformei;
 *   - GMV din metadata.gmv_cents al intrărilor de comision (scris la settle);
 *   - payout-urile din payout_requests.
 */
import { NextResponse } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import { dbQuery } from "@/lib/db";
import { requireAdmin } from "@/lib/admin/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withErrorHandling(async function GET(req: Request) {
  const actor = await requireAdmin(req, "finance");
  if (actor instanceof NextResponse) return actor;

  const url = new URL(req.url);
  const from = url.searchParams.get("from") || null;
  const to = url.searchParams.get("to") || null;

  const range = `created_at >= COALESCE($1::date, now() - interval '30 days')
                 AND created_at < COALESCE($2::date + interval '1 day', now() + interval '1 day')`;

  const [commissions, payouts] = await Promise.all([
    dbQuery<{
      ref_type: string;
      tx_count: string;
      commission_cents: string;
      gmv_cents: string;
    }>(
      `SELECT ref_type,
              count(*)                                            AS tx_count,
              COALESCE(sum(amount_cents), 0)                      AS commission_cents,
              COALESCE(sum((metadata->>'gmv_cents')::bigint), 0)  AS gmv_cents
         FROM wallet_ledger_entries
        WHERE kind = 'credit'
          AND ref_type IN ('commission_order', 'commission_ride')
          AND ${range}
        GROUP BY ref_type`,
      [from, to],
    ),
    dbQuery<{ status: string; cnt: string; amount_cents: string }>(
      `SELECT status, count(*) AS cnt, COALESCE(sum(amount_cents), 0) AS amount_cents
         FROM payout_requests
        WHERE requested_at >= COALESCE($1::date, now() - interval '30 days')
          AND requested_at < COALESCE($2::date + interval '1 day', now() + interval '1 day')
        GROUP BY status`,
      [from, to],
    ),
  ]);

  const byType = Object.fromEntries(
    commissions.rows.map((r) => [
      r.ref_type,
      {
        tx_count: Number(r.tx_count),
        commission_cents: Number(r.commission_cents),
        gmv_cents: Number(r.gmv_cents),
      },
    ]),
  );
  const totals = commissions.rows.reduce(
    (acc, r) => ({
      tx_count: acc.tx_count + Number(r.tx_count),
      commission_cents: acc.commission_cents + Number(r.commission_cents),
      gmv_cents: acc.gmv_cents + Number(r.gmv_cents),
    }),
    { tx_count: 0, commission_cents: 0, gmv_cents: 0 },
  );

  return NextResponse.json({
    period: { from, to },
    gmv_cents: totals.gmv_cents,
    commission_cents: totals.commission_cents,
    transactions: totals.tx_count,
    by_vertical: {
      eats: byType["commission_order"] ?? { tx_count: 0, commission_cents: 0, gmv_cents: 0 },
      go: byType["commission_ride"] ?? { tx_count: 0, commission_cents: 0, gmv_cents: 0 },
    },
    payouts: Object.fromEntries(
      payouts.rows.map((r) => [r.status, { count: Number(r.cnt), amount_cents: Number(r.amount_cents) }]),
    ),
  });
});
