import { NextResponse } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import { requireAdmin } from "@/lib/admin/guard";
import { dbQuery } from "@/lib/db";
import { distributeCreatorFund } from "@/lib/algo/attribution";
import { logAdminAction } from "@/lib/security/admin-audit";

export const dynamic = "force-dynamic";

/**
 * GET  /api/admin/creator-fund          — pool-urile lunare + sumar payout-uri
 * POST /api/admin/creator-fund          — distribuie fondul pentru o lună
 *   body: { month: "2026-07", poolCents: 500000 }
 *
 * Payout-urile ajung în wallet_ledger_entries prin creditUser() (cenți,
 * reason='creator_fund'), cu prag minim (feed_weights.fund_payout_min_cents).
 */

const DistributeSchema = z.object({
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "format asteptat YYYY-MM"),
    poolCents: z.number().int().min(0).max(1_000_000_000),
});

export const GET = withErrorHandling(async function GET(req: Request) {
    const actor = await requireAdmin(req, "finance");
    if (actor instanceof NextResponse) return actor;

    const { rows } = await dbQuery<{
        id: string;
        month: string;
        pool_cents: string;
        status: string;
        distributed_at: string | null;
        payouts: string;
        paid_cents: string;
    }>(
        `SELECT p.id, p.month::text AS month, p.pool_cents::text, p.status,
            p.distributed_at,
            COUNT(fp.id)::text AS payouts,
            COALESCE(SUM(fp.amount_cents) FILTER (WHERE fp.status = 'paid'), 0)::text AS paid_cents
       FROM creator_fund_pools p
       LEFT JOIN creator_fund_payouts fp ON fp.pool_id = p.id
      GROUP BY p.id
      ORDER BY p.month DESC
      LIMIT 24`,
    );

    return NextResponse.json({
        pools: rows.map((r) => ({
            id: r.id,
            month: r.month,
            poolCents: Number(r.pool_cents),
            status: r.status,
            distributedAt: r.distributed_at,
            payouts: Number(r.payouts),
            paidCents: Number(r.paid_cents),
        })),
    });
});

export const POST = withErrorHandling(async function POST(req: Request) {
    const actor = await requireAdmin(req, "finance");
    if (actor instanceof NextResponse) return actor;

    const parsed = DistributeSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json(
            { error: "invalid_body", details: parsed.error.flatten() },
            { status: 400 },
        );
    }

    const result = await distributeCreatorFund(
        `${parsed.data.month}-01`,
        parsed.data.poolCents,
    );
    await logAdminAction({
        action: "creator_fund.distribute",
        targetType: "creator_fund_pool",
        targetId: parsed.data.month,
        details: { poolCents: parsed.data.poolCents },
        req,
        actor,
    });
    return NextResponse.json({ ok: true, ...result });
});
