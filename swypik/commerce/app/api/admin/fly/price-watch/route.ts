/**
 * GET /api/admin/fly/price-watch — raport competitivitate prețuri Fly.
 *
 * Ultima scanare per rută: prețul nostru vs. cel mai mic preț din piață.
 * `beaten=true` = rute unde piața e mai ieftină decât noi (candidate la
 * ajustare de marjă). Autentificare: admin session sau Bearer admin token.
 */
import { NextResponse } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import { dbQuery } from "@/lib/db";
import { hasAdminSession, isAdminToken } from "@/lib/security/admin-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function isAdmin(req: Request): Promise<boolean> {
    const bearer = req.headers.get("authorization");
    if (bearer?.startsWith("Bearer ") && isAdminToken(bearer.slice(7))) return true;
    return hasAdminSession();
}

export const GET = withErrorHandling(async function GET(req: Request) {
    if (!(await isAdmin(req))) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { rows } = await dbQuery<{
        origin: string;
        destination: string;
        depart_date: string;
        our_total_cents: number | null;
        market_min_cents: number | null;
        market_airline: string | null;
        delta_cents: number | null;
        checked_at: string;
    }>(
        `SELECT DISTINCT ON (origin, destination)
                origin, destination, depart_date::text,
                our_total_cents, market_min_cents, market_airline,
                delta_cents, checked_at::text
         FROM fly_price_watch
         ORDER BY origin, destination, checked_at DESC`,
    );

    const routes = rows.map((r) => ({
        route: `${r.origin}→${r.destination}`,
        departDate: r.depart_date,
        ourRon: r.our_total_cents !== null ? r.our_total_cents / 100 : null,
        marketRon: r.market_min_cents !== null ? r.market_min_cents / 100 : null,
        marketAirline: r.market_airline,
        deltaRon: r.delta_cents !== null ? r.delta_cents / 100 : null,
        beaten: r.delta_cents !== null && r.delta_cents > 0,
        checkedAt: r.checked_at,
    }));

    return NextResponse.json({
        routes,
        summary: {
            total: routes.length,
            beaten: routes.filter((r) => r.beaten).length,
            cheapest: routes.filter((r) => r.deltaRon !== null && r.deltaRon <= 0).length,
            noMarketData: routes.filter((r) => r.marketRon === null).length,
        },
    });
});
