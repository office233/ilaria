/**
 * GET /api/fly/deals?origin=OTP — prețuri "de la X€" pentru destinațiile
 * populare, ca oamenii să vadă instant cât costă și să dea click.
 *
 * Interoghează Duffel pentru fiecare destinație (plecare peste ~30 zile,
 * one-way, 1 adult) și cache-uiește rezultatul în Redis 12h — deci utilizatorii
 * primesc răspuns instant, iar noi nu ardem rate-limit-ul furnizorului.
 */
import { NextResponse } from "next/server";
import { getFlyDeals } from "@/lib/fly/deals-service";
import { flyBookingGuard } from "@/lib/fly/gate";
import { applyCachePolicy } from "@/lib/http/cache-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
    const closed = flyBookingGuard();
    if (closed) return closed;
    const { searchParams } = new URL(req.url);
    const originRaw = (searchParams.get("origin") ?? "OTP").toUpperCase();
    const result = await getFlyDeals(originRaw);
    return applyCachePolicy(NextResponse.json(result), "fly/deals", req);
}

