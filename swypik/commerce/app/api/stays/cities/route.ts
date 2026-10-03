/** GET /api/stays/cities?q=bra — autocomplete orașe pentru cazări. */
import { NextResponse } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import { searchCities } from "@/lib/stays/cities";
import { applyCachePolicy } from "@/lib/http/cache-policy";

export const runtime = "nodejs";

export const GET = withErrorHandling(async function GET(req: Request) {
    const q = new URL(req.url).searchParams.get("q") ?? "";
    return applyCachePolicy(NextResponse.json({ cities: searchCities(q) }), "stays/cities", req);
});
